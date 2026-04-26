#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const workspace = process.env.OPENCLAW_WORKSPACE || '/data/.openclaw/workspace';
const manifestPath = process.env.ARES_INGEST_MANIFEST || path.join(workspace, 'memory', 'ingest-manifest.json');
const outPath = process.env.ARES_INGEST_EXPORT || path.join(workspace, 'memory', `core-ingest-${Date.now()}.jsonl`);
const maxChars = Number(process.env.ARES_INGEST_CHUNK_CHARS || 3500);
const overlap = Number(process.env.ARES_INGEST_CHUNK_OVERLAP || 250);

const defaultFiles = [
  'USER.md',
  'SOUL.md',
  'IDENTITY.md',
  'MEMORY.md',
  'AGENTS.md',
  'TOOLS.md',
];
const defaultDirs = ['core_files'];

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(md|txt|json|jsonl)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    let chunk = text.slice(start, end);
    if (end < text.length) {
      const breakAt = Math.max(chunk.lastIndexOf('\n\n'), chunk.lastIndexOf('\n#'), chunk.lastIndexOf('\n- '));
      if (breakAt > 800) {
        end = start + breakAt;
        chunk = text.slice(start, end);
      }
    }
    const trimmed = chunk.trim();
    if (trimmed) chunks.push(trimmed);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const manifest = loadJson(manifestPath, { files: {} });
const candidates = [];
for (const file of defaultFiles) candidates.push(path.join(workspace, file));
for (const dir of defaultDirs) candidates.push(...walk(path.join(workspace, dir)));

const records = [];
for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const hash = sha256(text);
  const rel = path.relative(workspace, file);
  if (manifest.files[rel]?.hash === hash) {
    console.log(`[core-ingest] unchanged, skip ${rel}`);
    continue;
  }

  const chunks = chunkText(text);
  chunks.forEach((content, index) => {
    records.push({
      content,
      metadata: {
        source: 'workspace_core_file',
        file_name: rel,
        file_hash: hash,
        chunk_index: index,
        chunk_count: chunks.length,
        memory_type: 'core_identity',
        priority: 10,
        protected: true,
        do_not_paraphrase: true,
      },
    });
  });

  manifest.files[rel] = {
    hash,
    chunks: chunks.length,
    ingested_at: new Date().toISOString(),
    mode: 'raw_protected_export',
  };
  console.log(`[core-ingest] prepared ${rel}: ${chunks.length} chunks`);
}

if (records.length) {
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[core-ingest] wrote ${records.length} records to ${outPath}`);
  console.log('[core-ingest] Import this JSONL with memory_store_raw or your Mem0/OpenClaw memory ingestion command.');
} else {
  console.log('[core-ingest] no changed files to ingest');
}
