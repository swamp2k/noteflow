from fastapi import APIRouter, Depends, HTTPException, Request, Response
import logging

from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

import httpx

from app.database import get_db
from app.models import User
from app.schemas import UserRegister, UserLogin, TotpEnableRequest
from app.dependencies import get_current_user
from app.config import settings
import app.auth.service as svc

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger("noteflow.auth")



def _user_response(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "totp_enabled": user.totp_enabled,
        "google_linked": bool(user.google_id),
        "created_at": user.created_at,
    }


@router.post("/register")
async def register(data: UserRegister, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(
        select(User).where((User.username == data.username) | (User.email == data.email))
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, "Username or email already taken")
    if len(data.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    user = User(
        username=data.username,
        email=data.email,
        hashed_pw=svc.hash_password(data.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _user_response(user)


@router.post("/login")
async def login(
    data: UserLogin,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    user = await svc.get_user_by_username_or_email(db, data.username)
    if not user:
        print(f"DEBUG LOGIN: User not found for identifier: {data.username}")
        raise HTTPException(401, "Invalid credentials")
    
    if not user.hashed_pw:
        print(f"DEBUG LOGIN: User {user.username} has no hashed_pw")
        raise HTTPException(401, "Invalid credentials")

    if not svc.verify_password(data.password, user.hashed_pw):
        print(f"DEBUG LOGIN: Password verification failed for user {user.username}")
        raise HTTPException(401, "Invalid credentials")
    if user.totp_enabled:
        if not data.totp_code:
            raise HTTPException(401, "2FA code required")
        if not svc.verify_totp(user.totp_secret, data.totp_code):
            raise HTTPException(401, "Invalid 2FA code")
    token = await svc.create_session(db, user.id, request.headers.get("user-agent"))
    secure = settings.BASE_URL.startswith("https")
    response.set_cookie(
        "session_token", token, httponly=True, samesite="lax",
        max_age=settings.SESSION_EXPIRE_SECONDS, secure=secure,
    )
    return _user_response(user)


@router.post("/logout")
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    token = request.cookies.get("session_token")
    if token:
        await svc.delete_session(db, token)
    response.delete_cookie("session_token")
    return {"ok": True}


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return _user_response(user)


@router.get("/google-enabled")
async def google_enabled():
    return {"enabled": bool(settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET)}


@router.get("/google")
async def google_oauth():
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(400, "Google OAuth not configured")
    redirect_uri = f"{settings.BASE_URL}/api/auth/google/callback"
    url = (
        "https://accounts.google.com/o/oauth2/v2/auth"
        f"?client_id={settings.GOOGLE_CLIENT_ID}"
        f"&redirect_uri={redirect_uri}"
        "&response_type=code"
        "&scope=openid%20email%20profile"
        "&access_type=offline"
    )
    return RedirectResponse(url)


@router.get("/google/callback")
async def google_callback(
    code: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    redirect_uri = f"{settings.BASE_URL}/api/auth/google/callback"
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code != 200:
            raise HTTPException(400, "Google OAuth token exchange failed")
        access_token = token_resp.json()["access_token"]

        userinfo_resp = await client.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if userinfo_resp.status_code != 200:
            raise HTTPException(400, "Failed to fetch Google user info")
        info = userinfo_resp.json()

    google_id = info["sub"]
    email = info.get("email", "")

    user = await svc.get_user_by_google_id(db, google_id)
    if not user:
        user = await svc.get_user_by_email(db, email)
        if user:
            user.google_id = google_id
            await db.commit()
        else:
            base_username = email.split("@")[0].replace(".", "_")
            username = base_username
            i = 1
            while (await db.execute(select(User).where(User.username == username))).scalar_one_or_none():
                username = f"{base_username}_{i}"
                i += 1
            user = User(username=username, email=email, google_id=google_id)
            db.add(user)
            await db.commit()
            await db.refresh(user)

    token = await svc.create_session(db, user.id, request.headers.get("user-agent"))
    secure = settings.BASE_URL.startswith("https")
    response.set_cookie(
        "session_token", token, httponly=True, samesite="lax",
        max_age=settings.SESSION_EXPIRE_SECONDS, secure=secure,
    )
    return RedirectResponse("/")


@router.post("/2fa/setup")
async def totp_setup(user: User = Depends(get_current_user)):
    secret = svc.generate_totp_secret()
    qr = svc.generate_totp_qr(secret, user.username)
    return {"secret": secret, "qr_image": qr}


@router.post("/2fa/enable")
async def totp_enable(
    data: TotpEnableRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    secret = request.headers.get("X-TOTP-Secret")
    if not secret:
        raise HTTPException(400, "Missing TOTP secret")
    if not svc.verify_totp(secret, data.code):
        raise HTTPException(400, "Invalid code")
    user.totp_secret = secret
    user.totp_enabled = True
    await db.commit()
    return {"ok": True}


@router.post("/2fa/disable")
async def totp_disable(
    data: TotpEnableRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not user.totp_enabled:
        raise HTTPException(400, "2FA is not enabled")
    if not svc.verify_totp(user.totp_secret, data.code):
        raise HTTPException(400, "Invalid code")
    user.totp_secret = None
    user.totp_enabled = False
    await db.commit()
    return {"ok": True}
