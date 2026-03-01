import base64
import io
from typing import Optional

from app.config import settings


async def generate_tags(content: str) -> list[str]:
    if not settings.GEMINI_API_KEY or len(content.strip()) < 10:
        return []
    try:
        from google import genai
        client = genai.Client(api_key=settings.GEMINI_API_KEY)
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=(
                "Generate 2-4 short lowercase topic tags for this note. "
                "Reply with ONLY the tags separated by commas, no # symbol, no explanation.\n\n"
                f"{content[:500]}"
            ),
        )
        raw = response.text.strip()
        tags = [t.strip().lower().replace(" ", "-") for t in raw.split(",") if t.strip()]
        return tags[:4]
    except Exception as e:
        print(f"Error generating tags: {e}")
        return []


async def extract_text(data: bytes, mime_type: str, filename: str) -> Optional[str]:
    if not settings.GEMINI_API_KEY:
        return None
    try:
        if mime_type.startswith("image/"):
            return await _ocr_image(data, mime_type)
        if mime_type == "application/pdf" or filename.lower().endswith(".pdf"):
            return await _extract_pdf(data)
    except Exception as e:
        print(f"Error extracting text: {e}")
        return None
    return None


async def _ocr_image(data: bytes, mime_type: str) -> Optional[str]:
    from google import genai
    from google.genai import types
    
    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=[
            types.Part.from_bytes(data=data, mime_type=mime_type),
            "Extract and return all readable text from this image. If there's no text, describe the image briefly in under 20 words."
        ]
    )
    return response.text.strip() or None


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
