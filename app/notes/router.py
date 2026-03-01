import io
import os
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Optional

import frontmatter
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy import select, func, or_, cast, String
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.dependencies import get_current_user
from app.models import Note, Attachment, User
from app.schemas import NotePatch
from app.config import settings
import app.ai.service as ai_svc

router = APIRouter(prefix="/api/notes", tags=["notes"])


def _att_response(att: Attachment) -> dict:
    return {
        "id": att.id,
        "filename": att.filename,
        "mime_type": att.mime_type,
        "size_bytes": att.size_bytes,
        "extracted_text": att.extracted_text,
    }


def _note_response(note: Note) -> dict:
    return {
        "id": note.id,
        "content": note.content,
        "source": note.source,
        "original_date": note.original_date,
        "ai_tags": note.ai_tags or [],
        "is_starred": note.is_starred,
        "created_at": note.created_at,
        "updated_at": note.updated_at,
        "attachments": [_att_response(a) for a in note.attachments],
    }


@router.get("")
async def list_notes(
    q: Optional[str] = None,
    tag: Optional[str] = None,
    source: Optional[str] = None,
    starred: Optional[bool] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=1000),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    base = select(Note).where(Note.user_id == user.id)

    if source:
        base = base.where(Note.source == source)
    if starred:
        base = base.where(Note.is_starred == True)  # noqa: E712
    if tag:
        # JSON array stored as text: ["tag1","tag2"] — match quoted exact tag
        base = base.where(cast(Note.ai_tags, String).contains(f'"{tag}"'))
    if q:
        pattern = f"%{q}%"
        base = base.where(or_(Note.content.ilike(pattern), Note.search_text.ilike(pattern)))

    total_result = await db.execute(select(func.count()).select_from(base.subquery()))
    total = total_result.scalar()

    query = (
        base.order_by(Note.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .options(selectinload(Note.attachments))
    )
    result = await db.execute(query)
    notes = result.scalars().all()

    return {
        "notes": [_note_response(n) for n in notes],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/import/upnote")
async def import_upnote(
    archive: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    data = await archive.read()
    imported = 0
    skipped = 0

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            md_files = [n for n in zf.namelist() if n.endswith(".md")]
            for name in md_files:
                try:
                    text = zf.read(name).decode("utf-8", errors="replace")
                    post = frontmatter.loads(text)
                    content = post.content.strip()
                    if not content:
                        skipped += 1
                        continue

                    original_date = None
                    if "date" in post.metadata:
                        d = post.metadata["date"]
                        if isinstance(d, datetime):
                            original_date = d
                        else:
                            try:
                                original_date = datetime.fromisoformat(str(d))
                            except ValueError:
                                pass

                    note = Note(
                        user_id=user.id,
                        content=content,
                        source="upnote",
                        original_date=original_date,
                        ai_tags=[],
                        search_text=content,
                    )
                    db.add(note)
                    imported += 1
                except Exception:
                    skipped += 1
    except zipfile.BadZipFile:
        raise HTTPException(400, "Invalid zip file")

    await db.commit()
    return {"imported": imported, "skipped": skipped}


@router.post("")
async def create_note(
    content: str = Form(...),
    files: list[UploadFile] = File(default=[]),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    note = Note(user_id=user.id, content=content, source="local")
    db.add(note)
    await db.flush()  # populate note.id

    search_parts = [content]
    for f in files:
        if not f.filename:
            continue
        raw = await f.read()
        ext = os.path.splitext(f.filename)[1]
        stored = f"{uuid.uuid4().hex}{ext}"
        os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
        with open(os.path.join(settings.UPLOAD_DIR, stored), "wb") as fp:
            fp.write(raw)

        extracted = await ai_svc.extract_text(raw, f.content_type or "", f.filename)

        att = Attachment(
            note_id=note.id,
            filename=f.filename,
            stored_name=stored,
            mime_type=f.content_type,
            size_bytes=len(raw),
            extracted_text=extracted,
        )
        db.add(att)
        if extracted:
            search_parts.append(extracted)

    tags = await ai_svc.generate_tags(content)
    note.ai_tags = tags
    note.search_text = "\n".join(search_parts)

    await db.commit()

    result = await db.execute(
        select(Note).where(Note.id == note.id).options(selectinload(Note.attachments))
    )
    return _note_response(result.scalar_one())


@router.get("/{note_id}")
async def get_note(
    note_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Note)
        .where(Note.id == note_id, Note.user_id == user.id)
        .options(selectinload(Note.attachments))
    )
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(404, "Note not found")
    return _note_response(note)


@router.patch("/{note_id}")
async def patch_note(
    note_id: int,
    data: NotePatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Note)
        .where(Note.id == note_id, Note.user_id == user.id)
        .options(selectinload(Note.attachments))
    )
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(404, "Note not found")

    if data.content is not None:
        note.content = data.content
        note.ai_tags = await ai_svc.generate_tags(data.content)
        note.search_text = data.content
    if data.is_starred is not None:
        note.is_starred = data.is_starred

    await db.commit()
    await db.refresh(note)
    return _note_response(note)


@router.delete("/{note_id}", status_code=204)
async def delete_note(
    note_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Note)
        .where(Note.id == note_id, Note.user_id == user.id)
        .options(selectinload(Note.attachments))
    )
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(404, "Note not found")

    for att in note.attachments:
        path = os.path.join(settings.UPLOAD_DIR, att.stored_name)
        if os.path.exists(path):
            os.remove(path)

    await db.delete(note)
    await db.commit()


@router.get("/{note_id}/attachments/{att_id}/file")
async def get_attachment_file(
    note_id: int,
    att_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Attachment)
        .join(Note)
        .where(
            Attachment.id == att_id,
            Note.id == note_id,
            Note.user_id == user.id,
        )
    )
    att = result.scalar_one_or_none()
    if not att:
        raise HTTPException(404, "Attachment not found")

    path = os.path.join(settings.UPLOAD_DIR, att.stored_name)
    if not os.path.exists(path):
        raise HTTPException(404, "File not found on disk")

    return FileResponse(path, media_type=att.mime_type, filename=att.filename)
