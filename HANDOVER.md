# NoteFlow – Claude Code Handover

## What this project is

NoteFlow is a personal note-taking PWA (Progressive Web App) for Martin Jeppesen.
It's a single-page app at **https://notes.jeppesen.cc** backed by a **Cloudflare Worker API**.

It is a replacement for a self-hosted Memos instance. All data has been migrated.

---

## Architecture

```
Browser (notes.jeppesen.cc)
  → Cloudflare Access (auth gate — Google login)
    → index.html on Simply.com (static file host, FTP deploy)
      → noteflow-api Worker (https://noteflow-api.jeppesen.cc)
          → D1 database "noteflow"
          → R2 bucket "noteflow-attachments"
          → Anthropic API (document indexing, OCR)
```

### Cloudflare resources

| Resource        | Name / ID                                    |
|-----------------|----------------------------------------------|
| CF Account      | Martin@jeppesen.cc / `98b26d7882ddf77fcd45529f35b11202` |
| Worker          | `noteflow-api` → https://noteflow-api.jeppesen.cc |
| D1 database     | `noteflow` / `075788a4-1d08-458e-9622-e10c561ee481` |
| R2 bucket       | `noteflow-attachments`                       |
| CF Access app   | Protects notes.jeppesen.cc + noteflow-api.jeppesen.cc |
| Old Worker      | `broad-moon-26bb` / memos-api.jeppesen.cc (keep as backup, serves PWA icons) |

---

## Worker (`noteflow-api`)

### Local project layout

```
noteflow-api/
  worker.js       ← source (see worker.js in this handover)
  wrangler.toml   ← bindings (see below)
  package.json    ← {"type":"module"} only, no dependencies
```

### wrangler.toml

```toml
name = "noteflow-api"
main = "worker.js"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "noteflow"
database_id = "075788a4-1d08-458e-9622-e10c561ee481"

[[r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "noteflow-attachments"

[vars]
TEAM_DOMAIN = "https://hadus.cloudflareaccess.com"
```

> ⚠️ Do NOT add `nodejs_compat` flag — it breaks esbuild for this worker.

### Secrets (set via `npx wrangler secret put`)

| Secret         | Value / notes                                         |
|----------------|-------------------------------------------------------|
| `POLICY_AUD`   | AUD tag from the CF Access application                |
| `ANTHROPIC_KEY`| Anthropic API key                                     |
| `MIGRATION_KEY`| **Delete this** — `npx wrangler secret delete MIGRATION_KEY` |

### Deploy

```bash
cd noteflow-api
npx wrangler deploy
```

---

## D1 Schema

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'PRIVATE',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE document_index (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  text_content TEXT NOT NULL,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE identity_aliases (
  jwt_email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id)
);
```

### Data

- All notes owned by `martin@jeppesen.cc`
- `swamp2k@gmail.com` (Google OAuth login) → aliased to `martin@jeppesen.cc` via `identity_aliases`
- 93 notes, 26 attachments migrated from old Memos instance

---

## Auth flow

1. Cloudflare Access protects both `notes.jeppesen.cc` and `noteflow-api.jeppesen.cc`
2. After login, CF sets a `CF_Authorization` cookie on `notes.jeppesen.cc`
3. **Cookies don't cross subdomains**, so the frontend reads the cookie via JS and sends it as the `Cf-Access-Jwt-Assertion` header on every API call
4. The worker verifies the JWT against CF's JWKS endpoint

Key frontend helper:
```js
function getCFToken() {
  const match = document.cookie.match(/CF_Authorization=([^;]+)/);
  return match ? match[1] : null;
}
function authHeaders() {
  const token = getCFToken();
  return token ? { 'Cf-Access-Jwt-Assertion': token } : {};
}
```
All fetch calls to the API must use `authHeaders()`. Image/file fetches must also use `authHeaders()` and create blob URLs — never use bare `<img src="...">` with an API URL.

---

## Frontend (`index.html`)

Single self-contained HTML file. No build step. Deployed via FTP to Simply.com.

- `API_BASE = 'https://noteflow-api.jeppesen.cc/api'`
- All settings persisted in `localStorage` under key `memostack_settings`
- Service worker: `noteflow-v5` cache (update version string to bust cache)

### Frontend deploy

FTP the new `index.html` to the Simply.com webroot for `notes.jeppesen.cc`.
After uploading, users need to clear site data in their browser (or wait for service worker to update).

---

## Known bugs / active work

### 1. Mobile infinite scroll layout bug (IN PROGRESS — not yet fixed)

**Symptom:** When infinite scrolling loads more notes on Android (Chrome/Brave), the card layout breaks — cards are pushed to the right half of the screen as if the sidebar is visible, leaving a large empty left column.

**Root cause hypothesis:** When `renderFeed()` runs in append mode, something is incorrectly setting or not clearing `margin-left` on `#content`, or the sidebar is re-showing. The `#content` has `margin-left: var(--sidebar-w)` on desktop, overridden to `margin-left: 0` in the `@media (max-width: 700px)` block. Suspected cause: some JS is modifying `#content`'s inline style or toggling a class during the append render path.

**What has been attempted:**
- `renderFeed()` was refactored to accept `appendMode` param — in append mode it skips `feed.innerHTML = ''` and only appends new cards
- Composer/delete-all-bar logic was gated behind `if (!appendMode)`
- Cards are diffed by `data-memo-name` attribute to avoid duplicate DOM insertions

**What to check next:**
- Look for any JS that touches `#content` style or class during a render cycle
- Check `switchView()` — it might be called or resetting something
- Check if IntersectionObserver's sentinel element position shifts and causes a re-layout
- Check if the `--sidebar-w` CSS variable is being modified
- Inspect on Android Chrome devtools (USB debugging) to see what's actually happening to `#content` at the moment of infinite scroll trigger

### 2. Mobile text size slider (IMPLEMENTED, not yet confirmed working)

A slider in Settings (12–22px, default 15px) controls `--mobile-font-size` CSS custom property, applied only inside `@media (max-width: 700px)`. Setting is persisted in localStorage.

---

## CSS layout reference

```
#sidebar      { width: var(--sidebar-w); position: fixed; left: 0; top: 0; height: 100%; }
#content      { margin-left: var(--sidebar-w); }  /* desktop */

@media (max-width: 700px) {
  #sidebar    { transform: translateX(-100%); }    /* hidden off-screen */
  #sidebar.open { transform: translateX(0); }      /* shown when hamburger tapped */
  #content    { margin-left: 0; }                  /* full width on mobile */
}
```

`--sidebar-w` is defined in `:root` as `220px` (approximately — check actual value in file).

---

## Worker API routes

```
GET    /api/me
GET    /api/tags
GET    /api/notes              ?pageSize, cursor, filter, tag, pinned
POST   /api/notes
GET    /api/notes/:id
PATCH  /api/notes/:id
DELETE /api/notes/:id
GET    /api/attachments
POST   /api/attachments        body: {note_id, filename, type, content (base64)}
GET    /api/attachments/:id    streams from R2
DELETE /api/attachments/:id
GET    /api/attachments/:id/index   returns {text, indexable, pending}
POST   /api/search             body: {q}
GET    /pwa/manifest.json      (no auth)
GET    /pwa/*                  proxied to memos-api.jeppesen.cc
```

Pagination: cursor-based using `created_at` timestamp. Response includes `nextCursor`.

---

## Document indexing pipeline

On attachment upload, if the file type is indexable, `ctx.waitUntil(indexDocument(...))` runs in the background after the response is sent.

Supported types:
- Images → Claude vision API
- PDF → Claude document API
- DOCX/DOC → ZIP extraction (word/document.xml) → Claude cleanup
- XLSX/XLS → ZIP extraction (xl/sharedStrings.xml) → Claude cleanup
- ODT/ODS/ODP → ZIP extraction (content.xml) → Claude cleanup
- txt/md/csv/json/xml → plain text decode

ZIP extraction uses `DecompressionStream('raw')` for deflate-compressed entries (compression method 8).

---

## Pending tasks

1. **Fix mobile infinite scroll layout bug** (primary issue)
2. **Delete MIGRATION_KEY secret:** `npx wrangler secret delete MIGRATION_KEY`
3. **Migrate frontend from Simply.com → Cloudflare Pages** (planned, not started)
4. **Decommission Memos on Unraid** (keep as read-only backup for now)
5. **Decommission broad-moon-26bb Worker** (after Pages migration — it still serves PWA icons)

---

## Development tips

- Worker changes: edit `noteflow-api/worker.js` → `npx wrangler deploy`
- Frontend changes: edit `index.html` → FTP to Simply.com (no build step)
- Test auth locally: not straightforward due to CF Access — easiest to deploy and test on the live domain
- D1 queries: `npx wrangler d1 execute noteflow --command "SELECT ..."`
- R2 inspection: Cloudflare dashboard → R2 → noteflow-attachments
