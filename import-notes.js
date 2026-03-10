#!/usr/bin/env node
// import-notes.js — Phase 1: import UpNote notes (no attachments, no tags)
//
// Usage:
//   MIGRATION_KEY=<secret> node import-notes.js [options]
//
// Options:
//   --dry-run              Parse and preview without sending any requests
//   --base-url <url>       API base (default: https://noteflow-api.jeppesen.cc)
//   --limit <n>            Only import first N notes (useful for staging tests)
//
// Resume: import-log.json tracks what's already been imported — safe to re-run.

import fs from 'fs';
import path from 'path';

const EXPORT_DIR  = '/var/home/martin/Downloads/UpNote_2026-03-10_08-20-44/Personal';
const LOG_FILE    = './import-log.json';
const DEFAULT_URL = 'https://noteflow-api.jeppesen.cc';
const IMPORT_USER = 'martin@jeppesen.cc';
const CONCURRENCY = 5;

// ── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const BASE_URL = (() => { const i = args.indexOf('--base-url'); return i !== -1 ? args[i+1] : DEFAULT_URL; })();
const LIMIT    = (() => { const i = args.indexOf('--limit');    return i !== -1 ? parseInt(args[i+1]) : Infinity; })();
const KEY      = process.env.MIGRATION_KEY;

if (!KEY && !DRY_RUN) {
  console.error('Error: set MIGRATION_KEY env var, e.g.:\n  MIGRATION_KEY=xxx node import-notes.js');
  process.exit(1);
}

// ── YAML frontmatter parser (only the fields we need) ────────────────────────
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  let inCategories = false;
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)/);
    if (m) {
      inCategories = m[1] === 'categories';
      if (m[1] === 'created') meta.created = m[2].trim();
      if (m[1] === 'date')    meta.updated = m[2].trim();
    } else if (inCategories && line.match(/^-\s+/)) {
      (meta.categories = meta.categories || []).push(line.replace(/^-\s+/, '').trim());
    }
  }
  return { meta, body: match[2] };
}

// ── Clean body: strip file refs and trailing tag lines ────────────────────────
function cleanBody(raw) {
  return raw
    // Strip all Files/ references — both image embeds and doc links
    // phase 2 will upload these as proper attachments
    .replace(/!?\[[^\]]*\]\(Files\/[^)]+\)[ \t]*(<br>)?[ \t]*/g, '')
    // Strip lines that are only hashtags (#tag1#tag2 or #tag1 #tag2 etc.)
    .replace(/^(#[a-zA-ZæøåÆØÅ0-9_-]+[ \t]*)+\r?$/gm, '')
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── "2024-05-28 22:11:29" → Unix seconds (treat as UTC) ──────────────────────
function toUnix(str) {
  if (!str) return null;
  return Math.floor(new Date(str.replace(' ', 'T') + 'Z').getTime() / 1000);
}

// ── Resume log ────────────────────────────────────────────────────────────────
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return {}; }
}
function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ── API call ──────────────────────────────────────────────────────────────────
async function postNote(content, created_at, updated_at) {
  const res = await fetch(`${BASE_URL}/api/notes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KEY}`,
      'X-Migration-User': IMPORT_USER,
      'Origin': 'https://notes.jeppesen.cc',
    },
    body: JSON.stringify({ content, created_at, updated_at }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).note.id;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const allFiles = fs.readdirSync(EXPORT_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();

  const log  = loadLog();
  const todo = allFiles
    .filter(f => !log[f])           // skip already imported
    .slice(0, LIMIT);               // respect --limit

  const done = Object.keys(log).filter(k => !k.endsWith('.error')).length;

  console.log(`Notes in export : ${allFiles.length}`);
  console.log(`Already imported: ${done}`);
  console.log(`To import       : ${todo.length}${LIMIT < Infinity ? ` (limited to ${LIMIT})` : ''}`);
  console.log(`Target          : ${BASE_URL}`);
  if (DRY_RUN) console.log('\n[DRY RUN — no requests sent]\n');
  else         console.log();

  if (DRY_RUN) {
    // Show first 5 parsed notes so you can verify the cleaning looks right
    for (const file of todo.slice(0, 5)) {
      const text     = fs.readFileSync(path.join(EXPORT_DIR, file), 'utf8');
      const { meta, body } = parseFrontmatter(text);
      const content  = cleanBody(body);
      const created  = toUnix(meta.created);
      const hasFiles = /!?\[.*?\]\(Files\//.test(body);
      console.log(`── ${file}`);
      console.log(`   created : ${meta.created || '(none)'} → ${created}`);
      console.log(`   category: ${(meta.categories || []).join(' | ') || '(none)'}`);
      console.log(`   files   : ${hasFiles ? 'YES (will be stripped — phase 2)' : 'none'}`);
      console.log(`   content : ${content.slice(0, 120).replace(/\n/g, '↵')}`);
      console.log();
    }
    if (todo.length > 5) console.log(`... and ${todo.length - 5} more`);
    return;
  }

  let imported = 0, failed = 0;

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);

    await Promise.allSettled(batch.map(async file => {
      const text         = fs.readFileSync(path.join(EXPORT_DIR, file), 'utf8');
      const { meta, body } = parseFrontmatter(text);
      const content      = cleanBody(body);

      // Skip notes that are empty after cleaning
      if (!content) {
        log[file] = 'EMPTY_SKIP';
        return;
      }

      const created_at = toUnix(meta.created) ?? Math.floor(Date.now() / 1000);
      const updated_at = toUnix(meta.updated) ?? created_at;

      try {
        const id = await postNote(content, created_at, updated_at);
        log[file] = id;
        imported++;
      } catch(e) {
        log[`${file}.error`] = e.message;
        failed++;
        console.error(`\nFailed: ${file} — ${e.message}`);
      }
    }));

    saveLog(log);  // save after every batch — safe to resume if interrupted
    process.stdout.write(`\r  ${done + imported}/${allFiles.length} imported  (${failed} failed)`);
  }

  console.log(`\n\nDone!`);
  console.log(`  Imported : ${imported}`);
  console.log(`  Failed   : ${failed}`);
  console.log(`  Skipped  : ${done} (already done from previous run)`);
  if (failed > 0) {
    console.log('\nTo retry failures: remove the .error entries from import-log.json and re-run.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
