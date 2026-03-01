# NoteFlow — Project Summary & Handoff

## What this is

A self-hosted, single-user note-taking web app inspired by [Memos](https://github.com/usememos/memos).
Built with Python/FastAPI backend, SQLite database, and a single-file HTML/CSS/JS frontend.
Designed to run as a Docker container on an Unraid home server.

---

## Current state

The project scaffold is complete. All files are written and structured correctly.
**It has not yet been tested end-to-end** — the next step is getting it running locally to verify everything works.

### What is implemented

- Full backend (FastAPI + SQLAlchemy async + SQLite)
- Auth system: username/password with bcrypt, server-side sessions via httpOnly cookie, TOTP 2FA with QR code, Google OAuth2
- Notes CRUD API: create, read, update, delete, star, paginate
- File attachments: multipart upload, stored to local filesystem
- AI integration: auto-tagging via Claude Haiku, image OCR, PDF text extraction (via Anthropic API)
- UpNote import: accepts `.zip` export, parses markdown frontmatter, stores as archived notes
- Full-text search across note content and AI-extracted attachment text
- Single-file frontend: login/register page + full notes app, wired to the API via fetch()
- Mobile-responsive layout with burger menu drawer
- Docker setup: Dockerfile + docker-compose.yml

### What is NOT yet done

- Markdown rendering (notes are stored as markdown but displayed as plain text — need `marked.js` or similar on the frontend)
- Note editing UI (PATCH endpoint exists on backend, frontend doesn't have an edit mode yet)
- Pagination in the feed (API supports it, frontend loads first 50 only)
- Session management UI (list/revoke active login sessions)
- End-to-end testing

---

## Tech stack

| Layer | Choice |
|---|---|
| Language | Python 3.12 |
| Web framework | FastAPI 0.115 |
| Database | SQLite via SQLAlchemy async (`aiosqlite`) |
| Auth | bcrypt (passlib) + custom session tokens + pyotp for TOTP |
| OAuth | Google OAuth2 (manual implementation via httpx) |
| AI | Anthropic API (`claude-haiku-4-5`) |
| PDF extraction | pypdf |
| Frontend | Vanilla HTML/CSS/JS (single file, no build step) |
| Container | Docker + docker-compose |

---

## Project file structure

```
noteflow/
├── .env.example            # Copy to .env and fill in
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── app/
    ├── main.py             # FastAPI app, lifespan, static file serving
    ├── config.py           # Pydantic settings from .env
    ├── database.py         # Async SQLAlchemy engine + session
    ├── models.py           # ORM: User, Session, Note, Attachment
    ├── schemas.py          # Pydantic request/response schemas
    ├── dependencies.py     # get_current_user() FastAPI dependency
    ├── auth/
    │   ├── router.py       # /api/auth/* endpoints
    │   └── service.py      # bcrypt, session CRUD, TOTP, user lookup
    ├── notes/
    │   └── router.py       # /api/notes/* endpoints + import
    ├── ai/
    │   └── service.py      # Tag generation, OCR, PDF extraction
    └── static/
        └── index.html      # Entire frontend
```

---

## Key API endpoints

### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login (returns session cookie) |
| POST | `/api/auth/logout` | Clear session |
| GET | `/api/auth/me` | Current user info |
| POST | `/api/auth/2fa/setup` | Generate TOTP secret + QR code |
| POST | `/api/auth/2fa/enable` | Confirm and enable 2FA |
| POST | `/api/auth/2fa/disable` | Disable 2FA |
| GET | `/api/auth/google` | Redirect to Google OAuth |
| GET | `/api/auth/google/callback` | OAuth callback |
| GET | `/api/auth/google-enabled` | Returns `{enabled: bool}` for frontend |

### Notes
| Method | Path | Description |
|---|---|---|
| GET | `/api/notes` | List/search notes (query params: `q`, `tag`, `source`, `starred`, `page`, `page_size`) |
| POST | `/api/notes` | Create note (multipart: `content` + optional `files[]`) |
| GET | `/api/notes/{id}` | Get single note |
| PATCH | `/api/notes/{id}` | Update content or starred status |
| DELETE | `/api/notes/{id}` | Delete note + attachments |
| GET | `/api/notes/{id}/attachments/{att_id}/file` | Download attachment |
| POST | `/api/notes/import/upnote` | Import UpNote `.zip` export |

---

## Database schema (simplified)

```
users           id, email, username, hashed_pw, google_id,
                totp_secret, totp_enabled, is_active, created_at

sessions        id (token), user_id, expires_at, user_agent

notes           id, user_id, content, source (local|upnote),
                original_date, ai_tags (JSON), search_text,
                is_starred, created_at, updated_at

attachments     id, note_id, filename, stored_name, mime_type,
                size_bytes, extracted_text
```

---

## Environment variables (.env)

```bash
# Required
SECRET_KEY=                  # openssl rand -hex 32
BASE_URL=https://notes.jeppesen.cc

# Database & storage (inside container)
DATABASE_URL=sqlite+aiosqlite:////data/noteflow.db
UPLOAD_DIR=/data/attachments

# AI (optional but recommended)
ANTHROPIC_API_KEY=sk-ant-...

# Google OAuth (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Session lifetime
SESSION_EXPIRE_SECONDS=604800   # 7 days
```

---

## Docker deployment on Unraid

Docker 27.5.1 is installed on the Unraid server (hostname: Tower) but the compose plugin is missing.

**Option A — Install compose plugin first:**
```bash
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL https://github.com/docker/compose/releases/download/v2.27.0/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version   # verify
docker compose up -d --build
```

**Option B — Plain docker run (no compose needed):**
```bash
cd /mnt/user/appdata/noteflow
docker build -t noteflow .
docker run -d \
  --name noteflow \
  --restart unless-stopped \
  -p 8100:8000 \
  -v /mnt/user/appdata/noteflow/data:/data \
  --env-file .env \
  -e DATABASE_URL=sqlite+aiosqlite:////data/noteflow.db \
  -e UPLOAD_DIR=/data/attachments \
  noteflow
```

App data (database + attachments) lives at: `/mnt/user/appdata/noteflow/data/`

---

## Domain & Cloudflare

- Domain: `jeppesen.cc` (DNS managed by Cloudflare)
- Intended URL: `https://notes.jeppesen.cc`
- Plan: Cloudflare proxying (orange cloud) for TLS + DDoS protection
- Auth is handled by the app itself (no Authelia/Authentik needed)
- Google OAuth redirect URI to register: `https://notes.jeppesen.cc/api/auth/google/callback`

---

## Known issues / things to check when testing

1. The `schemas.py` has a `UserResponse` model with a `google_linked` field but `models.py` returns a dict from `_user_response()` in the router — make sure these stay in sync
2. The `get_current_user` dependency raises 401 for unauthenticated requests — the frontend catches this on boot and shows the login page
3. The `source='local'` filter in the notes list means the main feed never shows UpNote imports — those only appear in the Archive section (this is intentional)
4. `ai_tags` is stored as a JSON column in SQLite — the `.contains()` filter in the notes router does a simple string match which works for tags without special characters

---

## Suggested next steps (in order)

1. **Get it running** — build the Docker image, create first user, verify login works
2. **Create a note** — check that saving works, AI tags appear, search finds it
3. **Test file upload** — attach an image, verify OCR snippet shows up
4. **Test 2FA** — enable it, log out, log back in with code
5. **Add markdown rendering** — add `marked.js` CDN to `index.html`, render `note.content` as HTML instead of plain text
6. **Add edit mode** — click a note to expand an edit textarea, call PATCH on save
7. **Test UpNote import** — get an export zip, import it, verify archive section appears
8. **Set up Cloudflare** — point DNS, configure reverse proxy, test HTTPS
9. **Configure Google OAuth** — set up GCP project, add credentials to .env
