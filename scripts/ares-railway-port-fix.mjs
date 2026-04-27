#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.ARES_UPLOAD_MODE === '1') {
  console.log('[ares-railway-port-fix] ARES_UPLOAD_MODE=1, starting upload page instead of OpenClaw gateway');
  await import('./ares-upload-server.mjs');
  process.exit(0);
}

const configPath = process.env.OPENCLAW_CONFIG_PATH || '/data/.openclaw/openclaw.json';
const railwayPort = Number(process.env.PORT || process.env.OPENCLAW_GATEWAY_PORT || 18789);
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';

function assertStrongGatewayToken() {
  const weakExamples = new Set(['change-me-long-random-token', 'password', 'openclaw', 'changeme', '123456']);
  if (!gatewayToken || gatewayToken.length < 32 || weakExamples.has(gatewayToken)) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN must be a unique random token with at least 32 characters. Update the Railway variable and redeploy.');
  }
}

function secureConfig(cfg) {
  assertStrongGatewayToken();
  cfg.gateway = cfg.gateway || {};
  if (Object.prototype.hasOwnProperty.call(cfg.gateway, 'host')) delete cfg.gateway.host;
  cfg.gateway.mode = 'local';
  cfg.gateway.port = railwayPort;
  cfg.gateway.bind = 'lan';
  cfg.gateway.auth = cfg.gateway.auth || {};
  cfg.gateway.auth.mode = 'token';
  cfg.gateway.auth.token = '${OPENCLAW_GATEWAY_TOKEN}';
  cfg.gateway.auth.rateLimit = {
    ...(cfg.gateway.auth.rateLimit || {}),
    maxAttempts: Number(process.env.OPENCLAW_AUTH_MAX_ATTEMPTS || 10),
    windowMs: Number(process.env.OPENCLAW_AUTH_WINDOW_MS || 60000),
    lockoutMs: Number(process.env.OPENCLAW_AUTH_LOCKOUT_MS || 300000),
    exemptLoopback: true,
  };
  cfg.discovery = cfg.discovery || {};
  cfg.discovery.mdns = { ...(cfg.discovery.mdns || {}), mode: 'off' };
  cfg.hooks = { ...(cfg.hooks || {}), enabled: false };
  cfg.channels = cfg.channels || {};
  cfg.channels.defaults = {
    ...(cfg.channels.defaults || {}),
    groupPolicy: 'allowlist',
    contextVisibility: 'allowlist',
  };
  if (cfg.channels.telegram) {
    cfg.channels.telegram.configWrites = false;
    cfg.channels.telegram.dmPolicy = process.env.TELEGRAM_DM_POLICY || cfg.channels.telegram.dmPolicy || 'allowlist';
    cfg.channels.telegram.groupPolicy = cfg.channels.telegram.groupPolicy || 'allowlist';
  }
  cfg.browser = {
    ...(cfg.browser || {}),
    ssrfPolicy: {
      ...((cfg.browser || {}).ssrfPolicy || {}),
      dangerouslyAllowPrivateNetwork: false,
      allowPrivateNetwork: false,
    },
  };
  return cfg;
}

try {
  if (fs.existsSync(configPath)) {
    const cfg = secureConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    console.log(`[ares-railway-port-fix] secured config: port=${railwayPort}, bind=lan, auth=token, mdns=off, hooks=off`);
  }
} catch (e) {
  console.error('[ares-railway-port-fix] persisted config patch failed:', e.message);
  process.exit(1);
}

const source = path.resolve('scripts/ares-railway-start.mjs');
const patched = path.resolve('/tmp/ares-railway-start.port-fixed.mjs');
let code = fs.readFileSync(source, 'utf8');
code = code.replace(
  "const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || process.env.PORT || 18789);",
  "const gatewayPort = Number(process.env.PORT || process.env.OPENCLAW_GATEWAY_PORT || 18789);"
);
code = code.replace(
  "port: gatewayPort,\n      auth:",
  "port: gatewayPort,\n      bind: 'lan',\n      auth:"
);
code = code.replace(
  "reload: { mode: 'hybrid', debounceMs: 300 },\n    },",
  "reload: { mode: 'hybrid', debounceMs: 300 },\n    },\n    discovery: { mdns: { mode: 'off' } },\n    hooks: { enabled: false },"
);
code = code.replace(
  "const child = spawn('node', ['openclaw.mjs', 'gateway', '--port', String(gatewayPort), '--verbose'],",
  "const child = spawn('node', ['openclaw.mjs', 'gateway', '--port', String(process.env.PORT || gatewayPort), '--verbose'],"
);
fs.writeFileSync(patched, code);
await import(pathToFileURL(patched).href);
