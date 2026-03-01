from pydantic import BaseModel, EmailStr
from typing import Optional, List
from datetime import datetime


class UserRegister(BaseModel):
    username: str
    email: EmailStr
    password: str


class UserLogin(BaseModel):
    username: str
    password: str
    totp_code: Optional[str] = None


class UserResponse(BaseModel):
    id: int
    username: str
    email: str
    totp_enabled: bool
    google_linked: bool
    created_at: datetime


class AttachmentResponse(BaseModel):
    id: int
    filename: str
    mime_type: Optional[str]
    size_bytes: int
    extracted_text: Optional[str]


class NoteResponse(BaseModel):
    id: int
    content: str
    source: str
    original_date: Optional[datetime]
    ai_tags: List[str]
    is_starred: bool
    created_at: datetime
    updated_at: datetime
    attachments: List[AttachmentResponse]


class NotesListResponse(BaseModel):
    notes: List[NoteResponse]
    total: int
    page: int
    page_size: int


class NotePatch(BaseModel):
    content: Optional[str] = None
    is_starred: Optional[bool] = None


class TotpSetupResponse(BaseModel):
    secret: str
    qr_image: str  # base64 PNG


class TotpEnableRequest(BaseModel):
    code: str
