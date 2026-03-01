
import asyncio
import sys
import os

# Add the current directory to sys.path so we can import app
sys.path.append(os.getcwd())

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select
from app.models import Base, User
import app.auth.service as svc
from app.config import settings

async def reset_user(username, email, password):
    print(f"Connecting to database: {settings.DATABASE_URL}")
    engine = create_async_engine(settings.DATABASE_URL, echo=True)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with async_session() as db:
        result = await db.execute(
            select(User).where((User.username == username) | (User.email == email))
        )
        user = result.scalar_one_or_none()

        if user:
            print(f"Found existing user: {user.username} (ID: {user.id})")
            print(f"Updating password...")
            user.hashed_pw = svc.hash_password(password)
        else:
            print(f"User not found. Creating new user: {username}")
            user = User(
                username=username,
                email=email,
                hashed_pw=svc.hash_password(password)
            )
            db.add(user)
        
        await db.commit()
        print(f"Successfully saved user: {user.username}")

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python scripts/reset_user.py <username> <email> <password>")
        sys.exit(1)
    
    un = sys.argv[1]
    em = sys.argv[2]
    pw = sys.argv[3]
    
    asyncio.run(reset_user(un, em, pw))
