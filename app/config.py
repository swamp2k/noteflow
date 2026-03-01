from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    SECRET_KEY: str = "change-me-in-production"
    BASE_URL: str = "http://localhost:8000"
    DATABASE_URL: str = "sqlite+aiosqlite:////data/noteflow.db"
    UPLOAD_DIR: str = "/data/attachments"
    ANTHROPIC_API_KEY: Optional[str] = None
    GOOGLE_CLIENT_ID: Optional[str] = None
    GOOGLE_CLIENT_SECRET: Optional[str] = None
    SESSION_EXPIRE_SECONDS: int = 604800

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
