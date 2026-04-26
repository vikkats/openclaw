#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const qdrantUrl = process.env.QDRANT_URL;
const qdrantKey = process.env.QDRANT_API_KEY || '';
const backupDir = process.env.QDRANT_BACKUP_DIR || '/data/backups/qdrant';
const collections = (process.env.QDRANT_BACKUP_COLLECTIONS || 'ares_mem0_memories,mem_ares_velen')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!qdrantUrl) throw new Error('Missing QDRANT_URL');
fs.mkdirSync(backupDir, { recursive: true });

function headers(extra = {}) {
  return {
    ...(qdrantKey ? { 'api-key': qdrantKey } : {}),
    ...extra,
  };
}

async function qdrant(pathname, options = {}) {
  const res = await fetch(`${qdrantUrl.replace(/\/$/, '')}${pathname}`, {
    ...options,
    headers: headers(options.headers || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const manifest = { created_at: new Date().toISOString(), qdrant_url: qdrantUrl, collections: [] };

for (const collection of collections) {
  console.log(`[qdrant-backup] snapshot ${collection}`);
  const info = await (await qdrant(`/collections/${encodeURIComponent(collection)}`)).json();
  const created = await (await qdrant(`/collections/${encodeURIComponent(collection)}/snapshots`, { method: 'POST' })).json();
  const snapshotName = created?.result?.name;
  if (!snapshotName) throw new Error(`No snapshot name returned for ${collection}: ${JSON.stringify(created)}`);

  const outName = `${collection}-${stamp}-${snapshotName}`;
  const outPath = path.join(backupDir, outName);
  const download = await qdrant(`/collections/${encodeURIComponent(collection)}/snapshots/${encodeURIComponent(snapshotName)}`);
  const buf = Buffer.from(await download.arrayBuffer());
  fs.writeFileSync(outPath, buf);

  manifest.collections.push({
    collection,
    snapshot: snapshotName,
    file: outName,
    bytes: buf.length,
    point_count: info?.result?.points_count,
    indexed_vectors_count: info?.result?.indexed_vectors_count,
    vectors: info?.result?.config?.params?.vectors,
  });

  console.log(`[qdrant-backup] saved ${outPath} (${buf.length} bytes)`);
}

const manifestPath = path.join(backupDir, `manifest-${stamp}.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[qdrant-backup] manifest ${manifestPath}`);
