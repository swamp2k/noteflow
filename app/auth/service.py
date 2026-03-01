import secrets
import io
import base64

import bcrypt
import pyotp
import qrcode
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models import User, Session
from app.config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


async def get_user_by_username_or_email(db: AsyncSession, identifier: str) -> User | None:
    result = await db.execute(
        select(User).where((User.username == identifier) | (User.email == identifier))
    )
    return result.scalar_one_or_none()


async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    result = await db.execute(select(User).where(User.email == email))
    return result.scalar_one_or_none()


async def get_user_by_google_id(db: AsyncSession, google_id: str) -> User | None:
    result = await db.execute(select(User).where(User.google_id == google_id))
    return result.scalar_one_or_none()


async def create_session(db: AsyncSession, user_id: int, user_agent: str | None = None) -> str:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(seconds=settings.SESSION_EXPIRE_SECONDS)
    session = Session(id=token, user_id=user_id, expires_at=expires, user_agent=user_agent)
    db.add(session)
    await db.commit()
    return token


async def delete_session(db: AsyncSession, token: str):
    result = await db.execute(select(Session).where(Session.id == token))
    session = result.scalar_one_or_none()
    if session:
        await db.delete(session)
        await db.commit()


def generate_totp_secret() -> str:
    return pyotp.random_base32()


def verify_totp(secret: str, code: str) -> bool:
    totp = pyotp.TOTP(secret)
    return totp.verify(code, valid_window=1)


def generate_totp_qr(secret: str, username: str, issuer: str = "NoteFlow") -> str:
    uri = pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=issuer)
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()
