#!/usr/bin/env node
// import-attachments.js — Phase 2: upload UpNote attachments to NoteFlow
//
// Usage:
//   MIGRATION_KEY=<secret> node import-attachments.js [options]
//
// Options:
//   --dry-run              Show what would be uploaded without sending requests
//   --base-url <url>       API base (default: https://noteflow-api.jeppesen.cc)
//   --limit <n>            Only process first N notes (for staging tests)
//
// Requires import-log.json from Phase 1 (maps note filename → note ID).
// Resume: import-attachments-log.json tracks uploaded attachments — safe to re-run.

import fs from 'fs';
import path from 'path';

const EXPORT_DIR  = '/var/home/martin/Downloads/UpNote_2026-03-10_08-20-44/Personal';
const FILES_DIR   = path.join(EXPORT_DIR, 'Files');
const NOTES_LOG   = './import-log.json';
const ATT_LOG     = './import-attachments-log.json';
const DEFAULT_URL = 'https://noteflow-api.jeppesen.cc';
const IMPORT_USER = 'martin@jeppesen.cc';
const NOTE_CONCURRENCY = 2;   // notes processed in parallel
const NOTE_DELAY_MS    = 300; // ms between note batches (gentle on Anthropic OCR)

// ── Args ──────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BASE_URL = (() => { const i = args.indexOf('--base-url'); return i !== -1 ? args[i+1] : DEFAULT_URL; })();
const LIMIT    = (() => { const i = args.indexOf('--limit');    return i !== -1 ? parseInt(args[i+1]) : Infinity; })();
const KEY      = process.env.MIGRATION_KEY;

if (!KEY && !DRY_RUN) {
  console.error('Error: set MIGRATION_KEY env var, e.g.:\n  MIGRATION_KEY=xxx node import-attachments.js');
  process.exit(1);
}

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4',
  zip: 'application/zip',
};
function mimeFor(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// ── Parse Files/ references from a note body ─────────────────────────────────
function extractFileRefs(text) {
  const refs = new Set();
  // Both image embeds ![...](Files/...) and doc links [...](Files/...)
  for (const m of text.matchAll(/!?\[[^\]]*\]\(Files\/([^)]+)\)/g)) {
    refs.add(decodeURIComponent(m[1]));
  }
  return [...refs];
}

// ── Logs ─────────────────────────────────────────────────────────────────────
function loadLog(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveLog(file, log) {
  fs.writeFileSync(file, JSON.stringify(log, null, 2));
}

// ── Upload one attachment (raw binary — no base64 overhead) ──────────────────
async function uploadAttachment(noteId, filename, filePath) {
  const data = fs.readFileSync(filePath);
  const mime = mimeFor(filename);
  const params = new URLSearchParams({ note_id: noteId, filename, skip_index: '1' });

  const res = await fetch(`${BASE_URL}/api/attachments?${params}`, {
    method: 'POST',
    headers: {
      'Content-Type': mime,
      'Authorization': `Bearer ${KEY}`,
      'X-Migration-User': IMPORT_USER,
      'Origin': 'https://notes.jeppesen.cc',
    },
    body: data,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).attachment.id;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const notesLog = loadLog(NOTES_LOG);
  const attLog   = loadLog(ATT_LOG);

  // Build work list: notes that have file references and a valid note ID
  const mdFiles = fs.readdirSync(EXPORT_DIR).filter(f => f.endsWith('.md')).sort();

  const work = [];
  let totalFiles = 0;

  for (const mdFile of mdFiles) {
    const noteId = notesLog[mdFile];
    if (!noteId || noteId === 'EMPTY_SKIP' || String(noteId).startsWith('ERROR')) continue;

    const text = fs.readFileSync(path.join(EXPORT_DIR, mdFile), 'utf8');
    const refs = extractFileRefs(text);
    if (refs.length === 0) continue;

    const pending = refs.filter(ref => {
      const key = `${mdFile}|||${ref}`;
      return !attLog[key]; // skip already uploaded
    });
    if (pending.length === 0) continue;

    work.push({ mdFile, noteId, pending });
    totalFiles += pending.length;
  }

  const doneCount = Object.keys(attLog).filter(k => !k.endsWith('.error')).length;
  const noteCount = work.length;

  console.log(`Notes with attachments : ${work.length}${LIMIT < Infinity ? ` (limited to ${LIMIT})` : ''}`);
  console.log(`Attachments to upload  : ${totalFiles}`);
  console.log(`Already uploaded       : ${doneCount}`);
  console.log(`Target                 : ${BASE_URL}`);
  if (DRY_RUN) console.log('\n[DRY RUN — no requests sent]\n');
  else         console.log();

  if (DRY_RUN) {
    for (const { mdFile, noteId, pending } of work.slice(0, 5)) {
      console.log(`── ${mdFile} (note: ${noteId})`);
      for (const ref of pending) {
        const filePath = path.join(FILES_DIR, ref);
        const exists   = fs.existsSync(filePath);
        const size     = exists ? Math.round(fs.statSync(filePath).size / 1024) + ' KB' : 'MISSING';
        console.log(`   ${exists ? '✓' : '✗'} ${ref} — ${mimeFor(ref)} — ${size}`);
      }
    }
    if (noteCount > 5) console.log(`\n... and ${noteCount - 5} more notes`);
    return;
  }

  const todo = work.slice(0, LIMIT);
  let uploaded = 0, failed = 0, missing = 0;

  for (let i = 0; i < todo.length; i += NOTE_CONCURRENCY) {
    const batch = todo.slice(i, i + NOTE_CONCURRENCY);

    await Promise.allSettled(batch.map(async ({ mdFile, noteId, pending }) => {
      for (const ref of pending) {
        const key      = `${mdFile}|||${ref}`;
        const filePath = path.join(FILES_DIR, ref);

        if (!fs.existsSync(filePath)) {
          attLog[`${key}.error`] = 'FILE_MISSING';
          missing++;
          continue;
        }

        try {
          const attId = await uploadAttachment(noteId, path.basename(ref), filePath);
          attLog[key] = attId;
          uploaded++;
        } catch(e) {
          attLog[`${key}.error`] = e.message;
          failed++;
          console.error(`\nFailed: ${ref} — ${e.message}`);
        }
      }
    }));

    saveLog(ATT_LOG, attLog);
    process.stdout.write(`\r  ${uploaded + doneCount} uploaded  (${failed} failed, ${missing} missing)`);

    if (i + NOTE_CONCURRENCY < todo.length) {
      await new Promise(r => setTimeout(r, NOTE_DELAY_MS));
    }
  }

  console.log(`\n\nDone!`);
  console.log(`  Uploaded : ${uploaded}`);
  console.log(`  Failed   : ${failed}`);
  console.log(`  Missing  : ${missing} (referenced in notes but not in Files/)`);
  console.log(`  Skipped  : ${doneCount} (already done from previous run)`);
  if (failed > 0) console.log('\nTo retry: remove .error entries from import-attachments-log.json and re-run.');
}

main().catch(e => { console.error(e); process.exit(1); });
