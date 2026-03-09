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
        const { content = '', visibility = 'PRIVATE', created_at, updated_at } = body;

        const id = nanoid('n_');
        // Support migrated timestamps (Unix seconds) or default to now
        const createdAt = created_at ? parseInt(created_at) : Math.floor(Date.now() / 1000);
        const updatedAt = updated_at ? parseInt(updated_at) : createdAt;

        await env.DB.prepare(
          'INSERT INTO notes (id, user_id, content, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, userId, content, visibility, createdAt, updatedAt).run();

        const tags = extractTags(content);
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

          // Re-sync tags if content changed
          if (body.content !== undefined) {
            await env.DB.prepare('DELETE FROM note_tags WHERE note_id = ?').bind(noteId).run();
            const tags = extractTags(content);
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
        const body = await request.json();
        const { note_id, filename, type: mimeType, content: b64content } = body;

        if (!note_id || !filename || !b64content) {
          return err('Missing note_id, filename, or content', 400, origin);
        }

        // Verify note belongs to user
        const note = await env.DB.prepare(
          'SELECT id FROM notes WHERE id = ? AND user_id = ?'
        ).bind(note_id, userId).first();
        if (!note) return err('Note not found', 404, origin);

        // Decode base64
        const binary = Uint8Array.from(atob(b64content), c => c.charCodeAt(0));

        // Store in R2
        const attId = nanoid('a_');
        const r2Key = `${userId}/${note_id}/${attId}/${filename}`;

        await env.ATTACHMENTS.put(r2Key, binary, {
          httpMetadata: { contentType: mimeType || 'application/octet-stream' },
          customMetadata: { filename, userId, noteId: note_id },
        });

        // Write metadata to D1
        await env.DB.prepare(
          'INSERT INTO attachments (id, note_id, user_id, filename, mime_type, size_bytes, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(attId, note_id, userId, filename, mimeType || 'application/octet-stream', binary.length, r2Key).run();

        // Fire indexing in the background — response returns immediately
        const willIndex = !!(env.ANTHROPIC_KEY && shouldIndex(mimeType, filename));
        if (willIndex) {
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

        return json({
          done: false,
          remaining: toIndex.length - 1,
          indexed: { id: att.id, filename: att.filename, status },
        }, 200, origin);
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
