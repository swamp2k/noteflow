import base64
import io
from typing import Optional

from app.config import settings


async def generate_tags(content: str) -> list[str]:
    if not settings.ANTHROPIC_API_KEY or len(content.strip()) < 10:
        return []
    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        msg = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=100,
            messages=[{
                "role": "user",
                "content": (
                    "Generate 2-4 short lowercase topic tags for this note. "
                    "Reply with ONLY the tags separated by commas, no # symbol, no explanation.\n\n"
                    f"{content[:500]}"
                ),
            }],
        )
        raw = msg.content[0].text.strip()
        tags = [t.strip().lower().replace(" ", "-") for t in raw.split(",") if t.strip()]
        return tags[:4]
    except Exception:
        return []


async def extract_text(data: bytes, mime_type: str, filename: str) -> Optional[str]:
    if not settings.ANTHROPIC_API_KEY:
        return None
    try:
        if mime_type.startswith("image/"):
            return await _ocr_image(data, mime_type)
        if mime_type == "application/pdf" or filename.lower().endswith(".pdf"):
            return await _extract_pdf(data)
    except Exception:
        return None
    return None


async def _ocr_image(data: bytes, mime_type: str) -> Optional[str]:
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    b64 = base64.standard_b64encode(data).decode()
    msg = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=400,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": mime_type, "data": b64},
                },
                {
                    "type": "text",
                    "text": (
                        "Extract and return all readable text from this image. "
                        "If there's no text, describe the image briefly in under 20 words."
                    ),
                },
            ],
        }],
    )
    return msg.content[0].text.strip() or None


async def _extract_pdf(data: bytes) -> Optional[str]:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    pages = []
    for page in reader.pages[:10]:  # cap at 10 pages
        text = page.extract_text()
        if text:
            pages.append(text.strip())
    result = "\n".join(pages)
    return result[:2000] if result else None
