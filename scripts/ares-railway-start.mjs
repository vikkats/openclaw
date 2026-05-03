#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

function boolEnv(name, fallback = false) {
  const value = optionalEnv(name, undefined);
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
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

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    env: process.env,
    ...options,
  });
}

function commandExists(command) {
  const result = run('sh', ['-lc', `command -v ${command}`]);
  return result.status === 0 && result.stdout.trim() !== '';
}

function commandPath(command) {
  const result = run('sh', ['-lc', `command -v ${command}`]);
  return result.status === 0 ? result.stdout.trim() : '';
}

function prependPath(dir) {
  if (!dir) return;
  const parts = String(process.env.PATH || '').split(':').filter(Boolean);
  if (!parts.includes(dir)) {
    process.env.PATH = `${dir}:${process.env.PATH || ''}`;
  }
}

function ensureOpenClawCli() {
  process.env.OPENCLAW_HOME = home;
  process.env.OPENCLAW_WORKSPACE = workspace;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.HOME = process.env.HOME || '/data';

  prependPath('/data/.npm-global/bin');
  prependPath('/usr/local/bin');
  prependPath('/usr/bin');

  const npmPrefix = run('npm', ['prefix', '-g']);
  if (npmPrefix.status === 0) prependPath(path.join(npmPrefix.stdout.trim(), 'bin'));

  if (!commandExists('openclaw')) {
    if (boolEnv('ARES_INSTALL_OPENCLAW_CLI', true)) {
      console.log('[ares-railway] openclaw CLI missing; installing openclaw@latest globally');
      const install = run('npm', ['install', '-g', 'openclaw@latest'], { stdio: 'inherit' });
      if (install.status !== 0) {
        console.warn(`[ares-railway] openclaw CLI install failed with status ${install.status}; gateway may fall back to bundled runtime`);
      }
    } else {
      console.warn('[ares-railway] openclaw CLI missing and ARES_INSTALL_OPENCLAW_CLI=false');
    }
  }

  if (commandExists('openclaw')) {
    const which = commandPath('openclaw');
    const version = run('openclaw', ['--version']);
    console.log(`[ares-railway] openclaw CLI path: ${which}`);
    console.log(`[ares-railway] openclaw CLI version: ${(version.stdout || version.stderr || '').trim()}`);
  } else {
    console.warn('[ares-railway] openclaw CLI still unavailable; native ClawHub/config/plugin commands may not work from agent sessions');
  }
}

function normalizePersistedConfigForCurrentOpenClaw() {
  try {
    if (!fs.existsSync(configPath)) return;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let changed = false;

    if (cfg.gateway && 'host' in cfg.gateway) {
      delete cfg.gateway.host;
      changed = true;
      console.log('[ares-railway] migrated config: removed gateway.host');
    }
    if (cfg.gateway && !('mode' in cfg.gateway)) {
      cfg.gateway.mode = 'local';
      changed = true;
      console.log('[ares-railway] migrated config: added gateway.mode=local');
    }

    if (cfg.channels?.telegram) {
      const staleTelegramKeys = [
        'streamMode',
        'chunkMode',
        'blockStreaming',
        'blockStreamingCoalesce',
        'draftChunk',
        'replyToMode',
        'linkPreview',
        'textChunkLimit',
        'accounts',
      ];
      for (const key of staleTelegramKeys) {
        if (Object.prototype.hasOwnProperty.call(cfg.channels.telegram, key)) {
          delete cfg.channels.telegram[key];
          changed = true;
        }
      }
      const desiredStreaming = { mode: 'off' };
      if (JSON.stringify(cfg.channels.telegram.streaming) !== JSON.stringify(desiredStreaming)) {
        cfg.channels.telegram.streaming = desiredStreaming;
        changed = true;
        console.log('[ares-railway] migrated config: normalized channels.telegram.streaming={mode:"off"}');
      }
    }

    if (cfg.browser?.ssrfPolicy && Object.prototype.hasOwnProperty.call(cfg.browser.ssrfPolicy, 'allowPrivateNetwork')) {
      delete cfg.browser.ssrfPolicy.allowPrivateNetwork;
      changed = true;
      console.log('[ares-railway] migrated config: removed browser.ssrfPolicy.allowPrivateNetwork');
    }

    if (changed) fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[ares-railway] config normalization failed:', e.message);
  }
}

ensureDir(home);
ensureDir(workspace);
ensureDir(path.join(workspace, 'core_files'));
ensureDir(path.join(workspace, 'memory'));
ensureDir(path.join(workspace, 'diary'));
ensureDir(path.join(workspace, 'memorized_diary'));
ensureDir(path.join(workspace, 'skills'));
ensureDir(path.join(workspace, '.agents', 'skills'));
ensureDir(path.join(workspace, 'autonomy', 'skills'));
ensureDir(path.join(workspace, 'autonomy', 'staging'));
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
      mode: 'local',
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

normalizePersistedConfigForCurrentOpenClaw();
ensureOpenClawCli();
normalizePersistedConfigForCurrentOpenClaw();

const useGlobalGateway = boolEnv('ARES_USE_GLOBAL_OPENCLAW_GATEWAY', true) && commandExists('openclaw');
const childCommand = useGlobalGateway ? 'openclaw' : 'node';
const childArgs = useGlobalGateway
  ? ['gateway', '--port', String(gatewayPort), '--verbose']
  : ['openclaw.mjs', 'gateway', '--port', String(gatewayPort), '--verbose'];

console.log('[ares-railway] starting gateway', {
  configPath,
  workspace,
  gatewayHost,
  gatewayPort,
  model: optionalEnv('NANO_GPT_MODEL', 'kimi-k2.5'),
  qdrantUrl: optionalEnv('QDRANT_URL', 'unset'),
  runtime: useGlobalGateway ? 'global-openclaw-cli' : 'bundled-repo-openclaw.mjs',
  command: `${childCommand} ${childArgs.join(' ')}`,
});

const child = spawn(childCommand, childArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: '/data',
    OPENCLAW_HOME: home,
    OPENCLAW_WORKSPACE: workspace,
    OPENCLAW_CONFIG_PATH: configPath,
    PATH: process.env.PATH,
  },
});

child.on('exit', (code, signal) => {
  console.log(`[ares-railway] gateway exited code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});
