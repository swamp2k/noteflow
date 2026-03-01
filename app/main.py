import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.database import engine, Base
from app.auth.router import router as auth_router
from app.notes.router import router as notes_router
from app.config import settings

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    yield


app = FastAPI(title="NoteFlow", lifespan=lifespan)

app.include_router(auth_router)
app.include_router(notes_router)

if os.path.isdir(STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/{path:path}")
async def spa_fallback(path: str):
    """Serve index.html for any path not matched by API routes."""
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))
