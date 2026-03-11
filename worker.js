// ─────────────────────────────────────────────────────────────────────────────
// NoteFlow v2 API Worker
// Bindings required:
//   DB         → D1 database "noteflow"
//   ATTACHMENTS → R2 bucket "noteflow-attachments"
// Environment variables required:
//   TEAM_DOMAIN  → https://hadus.cloudflareaccess.com
//   POLICY_AUD   → AUD tag from CF Access application
//   ANTHROPIC_KEY → for AI tagging / OCR
// ─────────────────────────────────────────────────────────────────────────────

// ── Nano ID (no crypto.randomUUID in all CF environments) ────────────────────
function nanoid(prefix = '') {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = prefix;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

// ── Extract #hashtags from content ───────────────────────────────────────────
function extractTags(content) {
  const matches = content.match(/#([a-zA-Z0-9_\-æøåÆØÅ]+)/g) || [];
  return [...new Set(matches.map(t => t.slice(1).toLowerCase()))];
}

// ── CORS headers ─────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = [
    'https://notes.jeppesen.cc',
    'https://noteflow.pages.dev',
  ];
  const o = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function err(msg, status = 400, origin = '') {
  return json({ error: msg }, status, origin);
}

// ── JWT verification via CF Access JWKS ──────────────────────────────────────
async function verifyJWT(request, env) {
  // Try header first, then cookie (browser sends both)
  // Read from Authorization: Bearer <token> (frontend), or cookie fallback
  const authHeader = request.headers.get('Authorization') || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/CF_Authorization=([^;]+)/);
    if (match) token = match[1];
  }
  if (!token) return null;

  try {
    // Fetch JWKS from Cloudflare Access (cached by CF edge)
    const jwksUrl = `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`;
    const jwksRes = await fetch(jwksUrl);
    const { keys } = await jwksRes.json();

    // Decode header to find kid
    const [headerB64] = token.split('.');
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
    const key = keys.find(k => k.kid === header.kid);
    if (!key) return null;

    // Import the public key
    const cryptoKey = await crypto.subtle.importKey(
      'jwk', key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );

    // Verify signature
    const [hdr, payload, sig] = token.split('.');
    const data = new TextEncoder().encode(`${hdr}.${payload}`);
    const signature = Uint8Array.from(
      atob(sig.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, data);
    if (!valid) return null;

    // Decode payload
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));

    // Check expiry and audience
    if (claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (env.POLICY_AUD && claims.aud !== env.POLICY_AUD &&
        !(Array.isArray(claims.aud) && claims.aud.includes(env.POLICY_AUD))) return null;

    return claims; // { email, sub, iat, exp, ... }
  } catch (e) {
    console.error('JWT verify error:', e.message);
    return null;
  }
}

// ── Ensure user exists in D1, resolving identity aliases ────────────────────
async function ensureUser(db, claims) {
  const jwtEmail = claims.email;
  // Check if this JWT email maps to a canonical user_id
  const alias = await db.prepare(
    'SELECT user_id FROM identity_aliases WHERE jwt_email = ?'
  ).bind(jwtEmail).first();
  const id = alias ? alias.user_id : jwtEmail;
  // Ensure the canonical user record exists
  await db.prepare(
    'INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)'
  ).bind(id, claims.name || id).run();
  return id;
}

async function ensureTagEmbeddingsTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS tag_embeddings (
    user_id    TEXT NOT NULL,
    tag        TEXT NOT NULL,
    vector     TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, tag)
  )`).run();
}

// ── Route handler ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── Serve PWA static assets (same as before, no auth needed) ─────────────
    if (url.pathname === '/pwa/manifest.json') {
      const manifest = {
        id: '/',
        name: 'NoteFlow',
        short_name: 'NoteFlow',
        description: 'Your personal note capture app',
        start_url: 'https://notes.jeppesen.cc/',
        scope: 'https://notes.jeppesen.cc/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f5f4f0',
        theme_color: '#5b6af0',
        icons: [
          { src: 'https://notes.jeppesen.cc/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'https://notes.jeppesen.cc/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        screenshots: [
          { src: 'https://noteflow-api.jeppesen.cc/pwa/screenshot-wide.svg', sizes: '1280x720', type: 'image/svg+xml', form_factor: 'wide', label: 'NoteFlow on desktop' },
          { src: 'https://noteflow-api.jeppesen.cc/pwa/screenshot-narrow.svg', sizes: '390x844', type: 'image/svg+xml', form_factor: 'narrow', label: 'NoteFlow on mobile' },
        ],
        share_target: {
          action: 'https://notes.jeppesen.cc/share-target',
          method: 'GET',
          enctype: 'application/x-www-form-urlencoded',
          params: { title: 'title', text: 'text', url: 'url' },
        },
        categories: ['productivity', 'utilities'],
      };
      return new Response(JSON.stringify(manifest), {
        headers: { 'Content-Type': 'application/manifest+json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' }
      });
    }

    // Static PWA assets — forward to existing worker for now
    if (url.pathname.startsWith('/pwa/') || url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
      return fetch('https://memos-api.jeppesen.cc' + url.pathname);
    }

    // ── GET /api/public/notes/:id — no auth required ─────────────────────────
    const pubMatch = url.pathname.match(/^\/api\/public\/notes\/([^/]+)$/);
    if (pubMatch && request.method === 'GET') {
      const noteId = pubMatch[1];
      const note = await env.DB.prepare(
        `SELECT n.id, n.content, n.created_at
         FROM notes n
         WHERE n.id = ? AND n.visibility = 'PUBLIC'`
      ).bind(noteId).first();
      if (!note) return err('Not found', 404, origin);
      const { results: attachments } = await env.DB.prepare(
        `SELECT id, filename, mime_type FROM attachments WHERE note_id = ?`
      ).bind(noteId).all();
      return json({
        id: note.id,
        content: note.content,
        created_at: note.created_at,
        attachments,
      }, 200, origin);
    }

    // ── GET /api/public/attachments/:id — no auth required ───────────────────
    const pubAttMatch = url.pathname.match(/^\/api\/public\/attachments\/([^/]+)$/);
    if (pubAttMatch && request.method === 'GET') {
      const attId = pubAttMatch[1];
      // Only serve if the parent note is PUBLIC
      const att = await env.DB.prepare(
        `SELECT a.r2_key, a.mime_type, a.filename
         FROM attachments a
         JOIN notes n ON n.id = a.note_id
         WHERE a.id = ? AND n.visibility = 'PUBLIC'`
      ).bind(attId).first();
      if (!att) return err('Not found', 404, origin);
      const obj = await env.ATTACHMENTS.get(att.r2_key);
      if (!obj) return err('Not found', 404, origin);
      return new Response(obj.body, {
        headers: {
          'Content-Type': att.mime_type || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
          ...corsHeaders(origin),
        },
      });
    }

    // ── All /api/* routes require auth ────────────────────────────────────────
    if (!url.pathname.startsWith('/api/')) {
      return new Response('NoteFlow API v2', { headers: cors });
    }

    // Migration key bypass — only active when MIGRATION_KEY secret is set.
    // Use: Authorization: Bearer <MIGRATION_KEY> header in migrate.js
    // Remove the secret after migration is complete.
    let claims;
    const authHeader = request.headers.get('Authorization') || '';
    if (env.MIGRATION_KEY && authHeader === `Bearer ${env.MIGRATION_KEY}`) {
      // Synthesise claims from X-Migration-User header (email of the account to migrate into)
      const migrationUser = request.headers.get('X-Migration-User') || 'martin@jeppesen.cc';
      claims = { email: migrationUser, name: 'Migration' };
    } else {
      claims = await verifyJWT(request, env);
      if (!claims) return err('Unauthorized', 401, origin);
    }

    const userId = await ensureUser(env.DB, claims);
    const path = url.pathname.replace(/\/$/, ''); // strip trailing slash
    const method = request.method;

    try {
      // ── GET /api/me ─────────────────────────────────────────────────────────
      if (path === '/api/me' && method === 'GET') {
        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
          .bind(userId).first();
        return json({ user, jwt_email: claims.email }, 200, origin);
      }

      // ── GET /api/tags ───────────────────────────────────────────────────────
      if (path === '/api/tags' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT tag, COUNT(*) as count FROM note_tags WHERE user_id = ? GROUP BY tag ORDER BY count DESC'
        ).bind(userId).all();
        return json({ tags: results.map(r => r.tag) }, 200, origin);
      }

      // ── GET /api/tags/graph ─────────────────────────────────────────────────
      if (path === '/api/tags/graph' && method === 'GET') {
        const { results: tags } = await env.DB.prepare(
          'SELECT tag, COUNT(DISTINCT note_id) as count FROM note_tags WHERE user_id = ? GROUP BY tag ORDER BY count DESC'
        ).bind(userId).all();
        const { results: edges } = await env.DB.prepare(
          `SELECT a.tag as source, b.tag as target, COUNT(*) as weight
           FROM note_tags a JOIN note_tags b ON a.note_id = b.note_id AND a.tag < b.tag
           WHERE a.user_id = ?
           GROUP BY a.tag, b.tag HAVING weight >= 2
           ORDER BY weight DESC LIMIT 500`
        ).bind(userId).all();
        return json({ tags, edges }, 200, origin);
      }

      // ── POST /api/tags/contexts — note snippets per tag for enriched embedding
      if (path === '/api/tags/contexts' && method === 'POST') {
        const { tags } = await request.json();
        if (!Array.isArray(tags) || tags.length === 0) return json({}, 200, origin);
        const contextMap = {};
        // D1 limit: 100 bound params per statement; userId takes 1, so 80 tags/batch is safe
        const BATCH = 80;
        for (let i = 0; i < tags.length; i += BATCH) {
          const batch = tags.slice(i, i + BATCH);
          const ph = batch.map(() => '?').join(',');
          const { results } = await env.DB.prepare(
            `SELECT nt.tag, SUBSTR(n.content, 1, 200) as snippet
             FROM note_tags nt JOIN notes n ON nt.note_id = n.id
             WHERE nt.user_id = ? AND nt.tag IN (${ph})
               AND n.content IS NOT NULL AND LENGTH(n.content) > 15
             ORDER BY n.created_at DESC`
          ).bind(userId, ...batch).all();
          for (const row of results) {
            if (!contextMap[row.tag]) contextMap[row.tag] = [];
            if (contextMap[row.tag].length < 3) {
              const snippet = row.snippet.replace(/[#*`\[\]]/g, '').replace(/\s+/g, ' ').trim();
              if (snippet.length > 15) contextMap[row.tag].push(snippet);
            }
          }
        }
        return json(contextMap, 200, origin);
      }

      // ── GET /api/tags/embeddings/status ────────────────────────────────────
      if (path === '/api/tags/embeddings/status' && method === 'GET') {
        await ensureTagEmbeddingsTable(env.DB);
        const { results: allTags } = await env.DB.prepare(
          'SELECT DISTINCT tag FROM note_tags WHERE user_id = ?'
        ).bind(userId).all();
        const { results: indexed } = await env.DB.prepare(
          'SELECT tag FROM tag_embeddings WHERE user_id = ?'
        ).bind(userId).all();
        const indexedSet = new Set(indexed.map(r => r.tag));
        const missing = allTags.map(r => r.tag).filter(t => !indexedSet.has(t));
        return json({ total: allTags.length, indexed: indexed.length, missing }, 200, origin);
      }

      // ── GET /api/tags/embeddings ────────────────────────────────────────────
      if (path === '/api/tags/embeddings' && method === 'GET') {
        await ensureTagEmbeddingsTable(env.DB);
        const { results } = await env.DB.prepare(
          'SELECT tag, vector FROM tag_embeddings WHERE user_id = ?'
        ).bind(userId).all();
        return json({ embeddings: results }, 200, origin);
      }

      // ── PUT /api/tags/embeddings ────────────────────────────────────────────
      if (path === '/api/tags/embeddings' && method === 'PUT') {
        await ensureTagEmbeddingsTable(env.DB);
        const { embeddings } = await request.json();
        if (!Array.isArray(embeddings) || embeddings.length === 0)
          return json({ ok: true, count: 0 }, 200, origin);
        const now = Math.floor(Date.now() / 1000);
        // D1 batch — upsert in chunks of 50
        const CHUNK = 50;
        for (let i = 0; i < embeddings.length; i += CHUNK) {
          const stmts = embeddings.slice(i, i + CHUNK).map(({ tag, vector }) =>
            env.DB.prepare(
              'INSERT OR REPLACE INTO tag_embeddings (user_id, tag, vector, created_at) VALUES (?, ?, ?, ?)'
            ).bind(userId, tag, typeof vector === 'string' ? vector : JSON.stringify(vector), now)
          );
          await env.DB.batch(stmts);
        }
        return json({ ok: true, count: embeddings.length }, 200, origin);
      }

      // ── DELETE /api/tags/embeddings ─────────────────────────────────────────
      if (path === '/api/tags/embeddings' && method === 'DELETE') {
        await ensureTagEmbeddingsTable(env.DB);
        await env.DB.prepare('DELETE FROM tag_embeddings WHERE user_id = ?').bind(userId).run();
        return json({ ok: true }, 200, origin);
      }

      // ── GET /api/notes ──────────────────────────────────────────────────────
      if (path === '/api/notes' && method === 'GET') {
        const pageSize  = Math.min(parseInt(url.searchParams.get('pageSize') || '20'), 100);
        const cursor    = url.searchParams.get('cursor');   // created_at of last item
        const filter    = url.searchParams.get('filter');   // starred|hidden|archived|shared
        const tag       = url.searchParams.get('tag');
        const pinned    = url.searchParams.get('pinned');

        let where = 'n.user_id = ?';
        const params = [userId];

        if (filter === 'archived') {
          where += ' AND n.archived = 1';
        } else if (filter === 'starred') {
          where += ' AND n.archived = 0';
          // starred = has #starred tag
          where += ' AND EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = \'starred\')';
        } else if (filter === 'hidden') {
          where += ' AND n.archived = 0';
          where += ' AND EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = \'hidden\')';
        } else if (filter === 'shared') {
          where += ' AND n.archived = 0 AND n.visibility = \'PUBLIC\'';
        } else {
          // default: all, excluding archived and hidden
          where += ' AND n.archived = 0';
          where += ' AND NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = \'hidden\')';
        }

        if (tag) {
          where += ' AND EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = ?)';
          params.push(tag);
        }

        if (pinned === '1') {
          where += ' AND n.pinned = 1';
        }

        if (cursor) {
          where += ' AND n.created_at < ?';
          params.push(parseInt(cursor));
        }

        params.push(pageSize + 1); // fetch one extra to detect next page

        const { results: notes } = await env.DB.prepare(`
          SELECT n.*, GROUP_CONCAT(nt.tag) as tags_csv
          FROM notes n
          LEFT JOIN note_tags nt ON nt.note_id = n.id
          WHERE ${where}
          GROUP BY n.id
          ORDER BY n.pinned DESC, n.created_at DESC
          LIMIT ?
        `).bind(...params).all();

        const hasMore = notes.length > pageSize;
        if (hasMore) notes.pop();

        // Attach attachment metadata
        const noteIds = notes.map(n => n.id);
        let attachmentMap = {};
        if (noteIds.length > 0) {
          const placeholders = noteIds.map(() => '?').join(',');
          const { results: atts } = await env.DB.prepare(
            `SELECT * FROM attachments WHERE note_id IN (${placeholders})`
          ).bind(...noteIds).all();
          for (const a of atts) {
            if (!attachmentMap[a.note_id]) attachmentMap[a.note_id] = [];
            attachmentMap[a.note_id].push(a);
          }
        }

        const formatted = notes.map(n => ({
          ...n,
          tags: n.tags_csv ? n.tags_csv.split(',') : [],
          tags_csv: undefined,
          attachments: attachmentMap[n.id] || [],
        }));

        const nextCursor = hasMore ? notes[notes.length - 1].created_at : null;
        return json({ notes: formatted, nextCursor }, 200, origin);
      }

      // ── POST /api/notes ─────────────────────────────────────────────────────
      if (path === '/api/notes' && method === 'POST') {
        const body = await request.json();
        const { content = '', visibility = 'PRIVATE', created_at, updated_at, tags: bodyTags } = body;

        const id = nanoid('n_');
        const createdAt = created_at ? parseInt(created_at) : Math.floor(Date.now() / 1000);
        const updatedAt = updated_at ? parseInt(updated_at) : createdAt;

        await env.DB.prepare(
          'INSERT INTO notes (id, user_id, content, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, userId, content, visibility, createdAt, updatedAt).run();

        // Use explicitly provided tags, falling back to extracting from content
        const tags = (Array.isArray(bodyTags) && bodyTags.length > 0)
          ? bodyTags.map(t => String(t).toLowerCase().trim()).filter(Boolean)
          : extractTags(content);
        if (tags.length > 0) {
          const tagInserts = tags.map(() => '(?, ?, ?)').join(',');
          const tagValues = tags.flatMap(t => [id, t, userId]);
          await env.DB.prepare(
            `INSERT OR IGNORE INTO note_tags (note_id, tag, user_id) VALUES ${tagInserts}`
          ).bind(...tagValues).run();
        }

        const note = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first();
        return json({ note: { ...note, tags } }, 201, origin);
      }

      // ── GET /api/notes/:id ──────────────────────────────────────────────────
      const noteMatch = path.match(/^\/api\/notes\/([^/]+)$/);
      if (noteMatch) {
        const noteId = noteMatch[1];

        if (method === 'GET') {
          const note = await env.DB.prepare(
            'SELECT * FROM notes WHERE id = ? AND user_id = ?'
          ).bind(noteId, userId).first();
          if (!note) return err('Not found', 404, origin);

          const { results: tags } = await env.DB.prepare(
            'SELECT tag FROM note_tags WHERE note_id = ?'
          ).bind(noteId).all();
          const { results: attachments } = await env.DB.prepare(
            'SELECT * FROM attachments WHERE note_id = ?'
          ).bind(noteId).all();

          return json({ note: { ...note, tags: tags.map(t => t.tag), attachments } }, 200, origin);
        }

        // ── PATCH /api/notes/:id ──────────────────────────────────────────────
        if (method === 'PATCH') {
          const note = await env.DB.prepare(
            'SELECT * FROM notes WHERE id = ? AND user_id = ?'
          ).bind(noteId, userId).first();
          if (!note) return err('Not found', 404, origin);

          const body = await request.json();
          const content    = body.content    !== undefined ? body.content    : note.content;
          const visibility = body.visibility !== undefined ? body.visibility : note.visibility;
          const pinned     = body.pinned     !== undefined ? (body.pinned ? 1 : 0) : note.pinned;
          const archived   = body.archived   !== undefined ? (body.archived ? 1 : 0) : note.archived;
          const updatedAt  = Math.floor(Date.now() / 1000);

          await env.DB.prepare(
            'UPDATE notes SET content = ?, visibility = ?, pinned = ?, archived = ?, updated_at = ? WHERE id = ?'
          ).bind(content, visibility, pinned, archived, updatedAt, noteId).run();

          // Re-sync tags: explicit tags array takes priority, else re-extract from content
          if (body.content !== undefined || Array.isArray(body.tags)) {
            await env.DB.prepare('DELETE FROM note_tags WHERE note_id = ?').bind(noteId).run();
            const tags = (Array.isArray(body.tags) && body.tags.length > 0)
              ? body.tags.map(t => String(t).toLowerCase().trim()).filter(Boolean)
              : extractTags(content);
            if (tags.length > 0) {
              const tagInserts = tags.map(() => '(?, ?, ?)').join(',');
              const tagValues = tags.flatMap(t => [noteId, t, userId]);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO note_tags (note_id, tag, user_id) VALUES ${tagInserts}`
              ).bind(...tagValues).run();
            }
          }

          const updated = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
          const { results: tags } = await env.DB.prepare(
            'SELECT tag FROM note_tags WHERE note_id = ?'
          ).bind(noteId).all();
          return json({ note: { ...updated, tags: tags.map(t => t.tag) } }, 200, origin);
        }

        // ── DELETE /api/notes/:id ─────────────────────────────────────────────
        if (method === 'DELETE') {
          const note = await env.DB.prepare(
            'SELECT * FROM notes WHERE id = ? AND user_id = ?'
          ).bind(noteId, userId).first();
          if (!note) return err('Not found', 404, origin);

          // Delete attachments from R2
          const { results: atts } = await env.DB.prepare(
            'SELECT r2_key FROM attachments WHERE note_id = ?'
          ).bind(noteId).all();
          await Promise.all(atts.map(a => env.ATTACHMENTS.delete(a.r2_key)));

          // Delete note (cascades to note_tags, attachments via FK)
          await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(noteId).run();
          return json({ deleted: true }, 200, origin);
        }
      }

      // ── GET /api/attachments ────────────────────────────────────────────────
      if (path === '/api/attachments' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM attachments WHERE user_id = ? ORDER BY created_at DESC'
        ).bind(userId).all();
        return json({ attachments: results }, 200, origin);
      }

      // ── POST /api/attachments ───────────────────────────────────────────────
      if (path === '/api/attachments' && method === 'POST') {
        const contentType = request.headers.get('Content-Type') || '';
        let note_id, filename, mimeType, binary, b64content;

        if (contentType.includes('application/json')) {
          // Legacy: JSON body with base64-encoded content
          const body = await request.json();
          ({ note_id, filename, type: mimeType, content: b64content } = body);
          if (!note_id || !filename || !b64content)
            return err('Missing note_id, filename, or content', 400, origin);
          const binaryStr = atob(b64content);
          binary = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) binary[i] = binaryStr.charCodeAt(i);
        } else {
          // Binary upload: metadata in query params, raw file as body
          note_id  = url.searchParams.get('note_id');
          filename = url.searchParams.get('filename');
          mimeType = contentType.split(';')[0].trim() || 'application/octet-stream';
          if (!note_id || !filename)
            return err('Missing note_id or filename query params', 400, origin);
          binary = new Uint8Array(await request.arrayBuffer());
        }

        // Verify note belongs to user
        const note = await env.DB.prepare(
          'SELECT id FROM notes WHERE id = ? AND user_id = ?'
        ).bind(note_id, userId).first();
        if (!note) return err('Note not found', 404, origin);

        // Store in R2
        const attId = nanoid('a_');
        const r2Key = `${userId}/${note_id}/${attId}/${filename}`;

        await env.ATTACHMENTS.put(r2Key, binary, {
          httpMetadata: { contentType: mimeType },
          customMetadata: { filename, userId, noteId: note_id },
        });

        // Write metadata to D1
        await env.DB.prepare(
          'INSERT INTO attachments (id, note_id, user_id, filename, mime_type, size_bytes, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(attId, note_id, userId, filename, mimeType, binary.length, r2Key).run();

        // Fire indexing in the background — response returns immediately
        // skip_index=1 defers indexing to /api/admin/reindex (used during bulk import)
        const skipIndex = url.searchParams.get('skip_index') === '1';
        const willIndex = !skipIndex && !!(env.ANTHROPIC_KEY && shouldIndex(mimeType, filename));
        if (willIndex) {
          if (!b64content) {
            // Convert binary back to base64 for the indexing function
            // Use chunked approach to avoid O(n²) string concat on large files
            const CHUNK = 8192;
            let str = '';
            for (let i = 0; i < binary.length; i += CHUNK) {
              str += String.fromCharCode(...binary.subarray(i, i + CHUNK));
            }
            b64content = btoa(str);
          }
          ctx.waitUntil(
            indexDocument(env, attId, filename, mimeType, b64content)
              .catch(e => console.error('Index error:', e.message))
          );
        }

        const attachment = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(attId).first();
        return json({ attachment, indexing: willIndex, indexed: false }, 201, origin);
      }

      // ── GET /api/attachments/:id/index — indexed text for preview ───────────
      const attIndexMatch = path.match(/^\/api\/attachments\/([^/]+)\/index$/);
      if (attIndexMatch && method === 'GET') {
        const attId = attIndexMatch[1];
        const att = await env.DB.prepare(
          'SELECT id FROM attachments WHERE id = ? AND user_id = ?'
        ).bind(attId, userId).first();
        if (!att) return err('Not found', 404, origin);
        const row = await env.DB.prepare(
          'SELECT text_content FROM document_index WHERE attachment_id = ?'
        ).bind(attId).first();
        const attRow = await env.DB.prepare(
          'SELECT filename, mime_type FROM attachments WHERE id = ?'
        ).bind(attId).first();
        const indexable = attRow ? shouldIndex(attRow.mime_type, attRow.filename) : false;
        return json({
          text: row?.text_content || null,
          indexable,
          pending: indexable && !row
        }, 200, origin);
      }

      // ── GET /api/attachments/:id ────────────────────────────────────────────
      const attMatch = path.match(/^\/api\/attachments\/([^/]+)$/);
      if (attMatch) {
        const attId = attMatch[1];

        if (method === 'GET') {
          const att = await env.DB.prepare(
            'SELECT * FROM attachments WHERE id = ? AND user_id = ?'
          ).bind(attId, userId).first();
          if (!att) return err('Not found', 404, origin);

          const object = await env.ATTACHMENTS.get(att.r2_key);
          if (!object) return err('File not found in storage', 404, origin);

          return new Response(object.body, {
            headers: {
              'Content-Type': att.mime_type,
              'Content-Disposition': `inline; filename="${att.filename}"`,
              'Cache-Control': 'private, max-age=3600',
              ...cors,
            },
          });
        }

        // ── DELETE /api/attachments/:id ───────────────────────────────────────
        if (method === 'DELETE') {
          const att = await env.DB.prepare(
            'SELECT * FROM attachments WHERE id = ? AND user_id = ?'
          ).bind(attId, userId).first();
          if (!att) return err('Not found', 404, origin);

          await env.ATTACHMENTS.delete(att.r2_key);
          await env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(attId).run();
          return json({ deleted: true }, 200, origin);
        }
      }

      // ── POST /api/search ────────────────────────────────────────────────────
      if (path === '/api/search' && method === 'POST') {
        const { q } = await request.json();
        if (!q || q.trim().length < 2) return json({ notes: [] }, 200, origin);

        const term = `%${q.trim()}%`;

        // Search note content
        const { results: noteResults } = await env.DB.prepare(`
          SELECT n.id, n.content, n.created_at, n.updated_at, n.visibility, n.pinned, n.archived,
                 GROUP_CONCAT(nt.tag) as tags_csv, NULL as matched_file
          FROM notes n
          LEFT JOIN note_tags nt ON nt.note_id = n.id
          WHERE n.user_id = ? AND n.archived = 0 AND n.content LIKE ?
          GROUP BY n.id
          ORDER BY n.created_at DESC
          LIMIT 50
        `).bind(userId, term).all();

        // Search document index
        const { results: docResults } = await env.DB.prepare(`
          SELECT n.id, n.content, n.created_at, n.updated_at, n.visibility, n.pinned, n.archived,
                 GROUP_CONCAT(nt.tag) as tags_csv,
                 a.filename as matched_file
          FROM document_index di
          JOIN attachments a ON a.id = di.attachment_id
          JOIN notes n ON n.id = a.note_id
          LEFT JOIN note_tags nt ON nt.note_id = n.id
          WHERE n.user_id = ? AND n.archived = 0 AND di.text_content LIKE ?
          GROUP BY n.id
          ORDER BY n.created_at DESC
          LIMIT 20
        `).bind(userId, term).all();

        // Merge, deduplicate by note id
        const seen = new Set();
        const merged = [];
        for (const n of [...noteResults, ...docResults]) {
          if (!seen.has(n.id)) {
            seen.add(n.id);
            merged.push({ ...n, tags: n.tags_csv ? n.tags_csv.split(',') : [], tags_csv: undefined });
          }
        }

        return json({ notes: merged }, 200, origin);
      }

      // ── POST /api/admin/reindex ─────────────────────────────────────────────
      // Processes ONE unindexed attachment per call (to stay within Worker time
      // limits). Call repeatedly until remaining === 0.
      if (path === '/api/admin/reindex' && method === 'POST') {
        const { results: unindexed } = await env.DB.prepare(`
          SELECT a.id, a.filename, a.mime_type, a.r2_key
          FROM attachments a
          WHERE a.user_id = ?
            AND a.id NOT IN (SELECT attachment_id FROM document_index)
        `).bind(userId).all();

        const toIndex = unindexed.filter(a => shouldIndex(a.mime_type, a.filename));

        if (toIndex.length === 0) {
          return json({ done: true, remaining: 0 }, 200, origin);
        }

        const att = toIndex[0];
        let status = 'ok';
        try {
          const obj = await env.ATTACHMENTS.get(att.r2_key);
          if (!obj) {
            console.log('reindex: R2 miss', att.id);
            status = 'r2_miss';
          } else {
            const buf = await obj.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = '';
            const CHUNK = 32768;
            for (let i = 0; i < bytes.length; i += CHUNK) {
              binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
            }
            const b64 = btoa(binary);
            await indexDocument(env, att.id, att.filename, att.mime_type, b64);
            console.log('reindex: done', att.filename);
          }
        } catch (e) {
          console.error('reindex: failed', att.filename, e.message);
          status = 'error';
        }

        // Always mark as processed — even on error — so the same file isn't
        // retried forever and remaining count actually decrements.
        await env.DB.prepare(
          'INSERT OR IGNORE INTO document_index (attachment_id, text_content, indexed_at) VALUES (?, ?, ?)'
        ).bind(att.id, '', Math.floor(Date.now() / 1000)).run();

        return json({
          done: false,
          remaining: toIndex.length - 1,
          indexed: { id: att.id, filename: att.filename, status },
        }, 200, origin);
      }

      // ── POST /api/notes/tag-contexts ─────────────────────────────────────
      // Returns combined note content + indexed attachment text per note ID.
      // Used by bulk tagger to enrich context for notes that are mostly images.
      if (path === '/api/notes/tag-contexts' && method === 'POST') {
        const { ids } = await request.json();
        if (!Array.isArray(ids) || ids.length === 0) return json({}, 200, origin);
        const safe = ids.slice(0, 90); // D1 max 100 bound params; 90 ids + 1 userId = 91
        const ph = safe.map(() => '?').join(',');

        const { results: notes } = await env.DB.prepare(
          `SELECT id, content FROM notes WHERE id IN (${ph}) AND user_id = ?`
        ).bind(...safe, userId).all();

        const { results: indexed } = await env.DB.prepare(
          `SELECT a.note_id, di.text_content
           FROM attachments a
           JOIN document_index di ON di.attachment_id = a.id
           WHERE a.note_id IN (${ph}) AND a.user_id = ?`
        ).bind(...safe, userId).all();

        const indexMap = {};
        for (const row of indexed) {
          if (!indexMap[row.note_id]) indexMap[row.note_id] = [];
          indexMap[row.note_id].push(row.text_content || '');
        }

        const contexts = {};
        for (const note of notes) {
          const parts = [note.content || '', ...(indexMap[note.id] || [])].filter(s => s.trim());
          contexts[note.id] = parts.join('\n\n').slice(0, 4000);
        }
        return json(contexts, 200, origin);
      }

      // ── GET /api/user/settings ────────────────────────────────────────────
      if (path === '/api/user/settings' && method === 'GET') {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT PRIMARY KEY,
            data    TEXT NOT NULL DEFAULT '{}'
          )`).run();
        const row = await env.DB.prepare(
          'SELECT data FROM user_settings WHERE user_id = ?'
        ).bind(userId).first();
        return json(row ? JSON.parse(row.data) : {}, 200, origin);
      }

      // ── PUT /api/user/settings ────────────────────────────────────────────
      if (path === '/api/user/settings' && method === 'PUT') {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT PRIMARY KEY,
            data    TEXT NOT NULL DEFAULT '{}'
          )`).run();
        const body = await request.json();
        await env.DB.prepare(
          'INSERT OR REPLACE INTO user_settings (user_id, data) VALUES (?, ?)'
        ).bind(userId, JSON.stringify(body)).run();
        return json({ ok: true }, 200, origin);
      }

      return err('Not found', 404, origin);

    } catch (e) {
      console.error('API error:', e.message, e.stack);
      return err('Internal server error', 500, origin);
    }
  }
};

// ── Document indexing helpers ─────────────────────────────────────────────────

function shouldIndex(mimeType, filename) {
  if (mimeType && mimeType.startsWith('image/')) return true;
  const ext = filename.split('.').pop().toLowerCase();
  const indexable = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'txt', 'md', 'csv', 'json', 'xml'];
  return indexable.includes(ext);
}

async function indexDocument(env, attId, filename, mimeType, b64content) {
  const ext = filename.split('.').pop().toLowerCase();
  let text = '';

  if (['txt', 'md', 'csv', 'json', 'xml'].includes(ext) || (mimeType && mimeType.startsWith('text/'))) {
    // Plain text — decode directly, no API call needed
    text = new TextDecoder().decode(
      Uint8Array.from(atob(b64content), c => c.charCodeAt(0))
    ).slice(0, 50000);

  } else if (['docx', 'doc'].includes(ext)) {
    const rawText = await extractDocxText(b64content);
    if (rawText && env.ANTHROPIC_KEY) {
      text = await extractTextViaAnthropic(env, rawText);
    } else {
      text = rawText;
    }
  } else if (['xlsx', 'xls'].includes(ext)) {
    const rawText = await extractXlsxText(b64content);
    if (rawText && env.ANTHROPIC_KEY) {
      text = await extractTextViaAnthropic(env, rawText);
    } else {
      text = rawText;
    }
  } else if (['odt', 'ods', 'odp'].includes(ext)) {
    const rawText = await extractOdfText(b64content);
    if (rawText && env.ANTHROPIC_KEY) {
      text = await extractTextViaAnthropic(env, rawText);
    } else {
      text = rawText;
    }

  } else if (ext === 'pdf' || mimeType === 'application/pdf') {
    if (env.ANTHROPIC_KEY) {
      text = await extractViaAnthropic(env, filename, 'application/pdf', b64content);
    }

  } else if (mimeType && mimeType.startsWith('image/')) {
    if (env.ANTHROPIC_KEY) {
      text = await extractViaAnthropic(env, filename, mimeType, b64content);
    }
  }

  if (text.trim()) {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO document_index (attachment_id, text_content, indexed_at) VALUES (?, ?, ?)'
    ).bind(attId, text.slice(0, 50000), Math.floor(Date.now() / 1000)).run();
  }
}

// ── ZIP extraction helpers (Uint8Array-based, reliable in CF Workers) ─────────

function findSeq(arr, str, from = 0) {
  const target = [];
  for (let i = 0; i < str.length; i++) target.push(str.charCodeAt(i));
  outer: for (let i = from; i <= arr.length - target.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (arr[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function arr2str(arr, from, to) {
  let s = '';
  const end = Math.min(to, arr.length);
  for (let i = from; i < end; i++) {
    const c = arr[i];
    s += (c >= 32 && c < 128) || c === 9 || c === 10 || c === 13
      ? String.fromCharCode(c) : ' ';
  }
  return s;
}

async function extractZipEntry(arr, entryName) {
  // Walk ZIP local file headers to find entryName, decompress if needed
  let pos = 0;
  while (pos < arr.length - 30) {
    if (arr[pos] !== 0x50 || arr[pos+1] !== 0x4B || arr[pos+2] !== 0x03 || arr[pos+3] !== 0x04) {
      pos++;
      continue;
    }
    const compression = arr[pos + 8]  | (arr[pos + 9]  << 8); // 0=store, 8=deflate
    const compSize    = arr[pos + 18] | (arr[pos + 19] << 8) | (arr[pos + 20] << 16) | (arr[pos + 21] << 24);
    const fnLen       = arr[pos + 26] | (arr[pos + 27] << 8);
    const extraLen    = arr[pos + 28] | (arr[pos + 29] << 8);
    const fnStart     = pos + 30;
    const dataStart   = fnStart + fnLen + extraLen;
    const dataEnd     = dataStart + compSize;

    const fn = arr2str(arr, fnStart, fnStart + fnLen);
    if (fn === entryName || fn.endsWith('/' + entryName)) {
      const data = arr.slice(dataStart, dataEnd);
      if (compression === 0) {
        // Stored — raw bytes
        return new TextDecoder().decode(data);
      } else if (compression === 8) {
        // Deflate — decompress via DecompressionStream('raw')
        try {
          const ds = new DecompressionStream('raw');
          const writer = ds.writable.getWriter();
          writer.write(data);
          writer.close();
          const out = await new Response(ds.readable).arrayBuffer();
          return new TextDecoder().decode(out);
        } catch(e) {
          // Fallback: 'deflate-raw' alias
          try {
            const ds2 = new DecompressionStream('deflate-raw');
            const w2 = ds2.writable.getWriter();
            w2.write(data);
            w2.close();
            const out2 = await new Response(ds2.readable).arrayBuffer();
            return new TextDecoder().decode(out2);
          } catch(e2) { return ''; }
        }
      }
      return ''; // unsupported compression
    }
    pos = dataStart + (compSize > 0 ? compSize : 0);
    if (pos <= fnStart) pos = fnStart + 1; // guard against infinite loop
  }
  return '';
}

async function extractDocxText(b64) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const xml = await extractZipEntry(arr, 'word/document.xml');
    if (!xml) return '';
    return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  } catch(e) { return ''; }
}

async function extractXlsxText(b64) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    let xml = await extractZipEntry(arr, 'xl/sharedStrings.xml');
    if (xml) {
      const matches = xml.match(/<t[^>]*>([^<]+)<\/t>/g) || [];
      const text = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ').trim();
      if (text) return text;
    }
    xml = await extractZipEntry(arr, 'xl/worksheets/sheet1.xml');
    if (!xml) return '';
    return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  } catch(e) { return ''; }
}

async function extractOdfText(b64) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const xml = await extractZipEntry(arr, 'content.xml');
    if (!xml) return '';
    return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  } catch(e) { return ''; }
}

// Send already-extracted text to Claude for cleanup/summarization
async function extractTextViaAnthropic(env, rawText) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content:
          'Clean up this raw text extracted from an Office document. Remove XML artifacts, fix spacing, and return just the readable content. Content may be in Danish or English.\n\n' +
          rawText.slice(0, 8000)
        }]
      })
    });
    const data = await res.json();
    return data.content?.[0]?.text || rawText;
  } catch(e) { return rawText; }
}

async function extractViaAnthropic(env, filename, mimeType, b64content) {
  // Only call this for PDF and images — the Anthropic API document type only supports PDF
  try {
    const isImage = mimeType && mimeType.startsWith('image/');
    const contentBlock = isImage
      ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64content } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64content } };
    const prompt = isImage
      ? 'Describe what is in this image and extract any visible text. Be thorough but concise. Content may be in Danish or English.'
      : 'Extract all text content from this document. Return only the raw text, no commentary.';
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    };
    if (!isImage) headers['anthropic-beta'] = 'pdfs-2024-09-25';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('extractViaAnthropic error', res.status, filename, JSON.stringify(data).slice(0, 300));
      return '';
    }
    return data.content?.[0]?.text || '';
  } catch(e) {
    console.error('extractViaAnthropic exception', filename, e.message);
    return '';
  }
}
