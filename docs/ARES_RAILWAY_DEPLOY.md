# Ares Railway Deployment

This branch adds a small Railway wrapper around the official OpenClaw repo so Victoria can run her own gateway without Kimiclaw sandbox/provider surprises.

## What this adds

- `Dockerfile.railway` — builds OpenClaw from this repo and runs it from `/data`.
- `railway.json` — tells Railway to use the Dockerfile.
- `scripts/ares-railway-start.mjs` — creates a first-run OpenClaw config from Railway env vars, then starts the gateway.
- `scripts/ares-qdrant-snapshot.mjs` — creates downloadable Qdrant collection snapshots.
- `scripts/ares-core-ingest.mjs` — chunks core workspace files into protected JSONL records for raw memory ingestion.
- `.env.railway.example` — list of variables to copy into Railway.

## Railway setup

1. Create a new Railway service from this GitHub repo/branch.
2. Select `Dockerfile.railway` if Railway does not auto-detect it.
3. Add a persistent volume mounted at `/data`.
4. Copy variables from `.env.railway.example` into Railway Variables.
5. Set real secrets in Railway only. Never commit real API keys.
6. Deploy.

## Required variables

```bash
OPENCLAW_GATEWAY_TOKEN=long-random-token
NANOGPT_API_KEY=...
NANO_GPT_BASE_URL=https://nano-gpt.com/api/subscription/v1
NANO_GPT_MODEL=kimi-k2.5
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOW_FROM=tg:123456789
QDRANT_URL=https://qdrant-production-4901.up.railway.app
QDRANT_API_KEY=...
```

`TELEGRAM_ALLOW_FROM` should be the Telegram sender id in OpenClaw format. Keep `TELEGRAM_DM_POLICY=allowlist` unless intentionally opening access.

## First boot

On first boot, `scripts/ares-railway-start.mjs` writes:

```text
/data/.openclaw/openclaw.json
/data/.openclaw/workspace/
```

The starter config:

- binds the gateway to `0.0.0.0:18789`
- enables Telegram
- creates a custom NanoGPT OpenAI-compatible provider
- sets the primary model to `nanogpt/${NANO_GPT_MODEL}`
- sets heartbeat to `0m` by default
- creates placeholder workspace files: `SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, `AGENTS.md`, `TOOLS.md`

After first boot, OpenClaw owns `/data/.openclaw/openclaw.json`. Edit that file or use the Control UI/CLI if you need to change runtime config.

## Qdrant backup

Run this inside the Railway shell or as a one-off job:

```bash
node scripts/ares-qdrant-snapshot.mjs
```

Defaults:

```bash
QDRANT_BACKUP_COLLECTIONS=ares_mem0_memories,mem_ares_velen
QDRANT_BACKUP_DIR=/data/backups/qdrant
```

The script creates collection snapshots, downloads them into the volume, and writes a manifest.

## Core file chunk export

Run:

```bash
node scripts/ares-core-ingest.mjs
```

It reads:

```text
USER.md
SOUL.md
IDENTITY.md
MEMORY.md
AGENTS.md
TOOLS.md
core_files/*
```

and writes protected JSONL chunks under:

```text
/data/.openclaw/workspace/memory/core-ingest-*.jsonl
```

This script does not directly write into Mem0 yet. It prepares safe raw/protected records with metadata so they can be imported using the active Mem0/OpenClaw memory tool or a future importer.

## Important collection rule

Keep collections separated:

```text
mem_ares_velen        old SillyTavern/ChatGPT archive, read/search only
ares_mem0_memories   new live OpenClaw/Mem0 memory
```

Do not write new Mem0 memories into `mem_ares_velen` unless intentionally migrating/rebuilding the archive.

## Notes

This deployment scaffold avoids changing OpenClaw core internals. It is intended as a stable starting point. Once the gateway boots and Telegram works, deeper improvements can be added in a second PR: route logging, explicit archive search, direct Mem0 import, and heartbeat/job dashboards.
