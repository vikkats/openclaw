#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const home = process.env.OPENCLAW_HOME || '/data/.openclaw';
const workspace = process.env.OPENCLAW_WORKSPACE || path.join(home, 'workspace');
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(home, 'openclaw.json');
const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || process.env.PORT || 18789);
const gatewayHost = process.env.OPENCLAW_GATEWAY_HOST || '0.0.0.0';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optionalEnv(name, fallback = undefined) {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeIfMissing(file, content) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
}

function parseAllowFrom(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

ensureDir(home);
ensureDir(workspace);
ensureDir(path.join(workspace, 'core_files'));
ensureDir(path.join(workspace, 'memory'));
ensureDir(path.join(workspace, 'diary'));
ensureDir(path.join(workspace, 'memorized_diary'));
ensureDir('/data/backups/qdrant');

writeIfMissing(path.join(workspace, 'SOUL.md'), '# SOUL.md\n\nAres core identity file. Replace this placeholder through the Railway shell or OpenClaw file tools.\n');
writeIfMissing(path.join(workspace, 'USER.md'), '# USER.md\n\nVictoria core user file. Replace this placeholder through the Railway shell or OpenClaw file tools.\n');
writeIfMissing(path.join(workspace, 'IDENTITY.md'), '# IDENTITY.md\n\nRuntime identity anchors.\n');
writeIfMissing(path.join(workspace, 'MEMORY.md'), '# MEMORY.md\n\nPersistent memory notes and import manifest references.\n');
writeIfMissing(path.join(workspace, 'AGENTS.md'), '# AGENTS.md\n\nRailway OpenClaw agent workspace.\n');
writeIfMissing(path.join(workspace, 'TOOLS.md'), '# TOOLS.md\n\nTools/runtime notes.\n');

if (!fs.existsSync(configPath)) {
  const nanogptKey = requiredEnv('NANOGPT_API_KEY');
  const telegramToken = requiredEnv('TELEGRAM_BOT_TOKEN');
  const allowFrom = parseAllowFrom(requiredEnv('TELEGRAM_ALLOW_FROM'));
  const gatewayToken = requiredEnv('OPENCLAW_GATEWAY_TOKEN');

  const modelId = optionalEnv('NANO_GPT_MODEL', 'kimi-k2.5');
  const providerId = optionalEnv('NANO_GPT_PROVIDER_ID', 'nanogpt');
  const modelRef = `${providerId}/${modelId}`;
  const baseUrl = optionalEnv('NANO_GPT_BASE_URL', 'https://nano-gpt.com/api/subscription/v1');
  const contextTokens = Number(optionalEnv('NANO_GPT_CONTEXT_TOKENS', '131072'));
  const maxTokens = Number(optionalEnv('NANO_GPT_MAX_TOKENS', '8192'));
  const heartbeatEvery = optionalEnv('OPENCLAW_HEARTBEAT_EVERY', '0m');
  const heartbeatTarget = optionalEnv('OPENCLAW_HEARTBEAT_TARGET', 'last');

  const config = {
    gateway: {
      host: gatewayHost,
      port: gatewayPort,
      auth: { token: gatewayToken },
      reload: { mode: 'hybrid', debounceMs: 300 },
    },
    env: {
      NANOGPT_API_KEY: nanogptKey,
      TELEGRAM_BOT_TOKEN: telegramToken,
      QDRANT_URL: optionalEnv('QDRANT_URL', ''),
      QDRANT_API_KEY: optionalEnv('QDRANT_API_KEY', ''),
      OPENROUTER_API_KEY: optionalEnv('OPENROUTER_API_KEY', ''),
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: modelRef, fallbacks: [] },
        models: {
          [modelRef]: { alias: `NanoGPT ${modelId}` },
        },
        heartbeat: {
          every: heartbeatEvery,
          target: heartbeatTarget,
        },
      },
    },
    models: {
      mode: 'merge',
      providers: {
        [providerId]: {
          baseUrl,
          apiKey: '${NANOGPT_API_KEY}',
          api: 'openai-completions',
          models: [
            {
              id: modelId,
              name: `NanoGPT ${modelId}`,
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: contextTokens,
              contextTokens,
              maxTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: { requiresStringContent: false, supportsDeveloperRole: false },
            },
          ],
        },
      },
    },
    channels: {
      telegram: {
        enabled: true,
        botToken: '${TELEGRAM_BOT_TOKEN}',
        dmPolicy: optionalEnv('TELEGRAM_DM_POLICY', 'allowlist'),
        allowFrom,
      },
    },
    tools: {
      profile: 'coding',
      sessions: { visibility: 'agent' },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[ares-railway] wrote initial config: ${configPath}`);
} else {
  console.log(`[ares-railway] using existing config: ${configPath}`);
}

console.log('[ares-railway] starting gateway', {
  configPath,
  workspace,
  gatewayHost,
  gatewayPort,
  model: optionalEnv('NANO_GPT_MODEL', 'kimi-k2.5'),
  qdrantUrl: optionalEnv('QDRANT_URL', 'unset'),
});

const child = spawn('node', ['openclaw.mjs', 'gateway', '--host', gatewayHost, '--port', String(gatewayPort), '--verbose'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: '/data',
    OPENCLAW_CONFIG_PATH: configPath,
  },
});

child.on('exit', (code, signal) => {
  console.log(`[ares-railway] gateway exited code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});
