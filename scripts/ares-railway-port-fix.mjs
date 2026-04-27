#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const configPath = process.env.OPENCLAW_CONFIG_PATH || '/data/.openclaw/openclaw.json';
const railwayPort = Number(process.env.PORT || process.env.OPENCLAW_GATEWAY_PORT || 18789);

try {
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.gateway = cfg.gateway || {};
    if (Object.prototype.hasOwnProperty.call(cfg.gateway, 'host')) delete cfg.gateway.host;
    cfg.gateway.mode = 'local';
    cfg.gateway.port = railwayPort;
    cfg.gateway.bind = 'lan';
    cfg.discovery = cfg.discovery || {};
    cfg.discovery.mdns = { ...(cfg.discovery.mdns || {}), mode: 'off' };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    console.log(`[ares-railway-port-fix] set gateway.port=${railwayPort}, bind=lan, mdns=off`);
  }
} catch (e) {
  console.error('[ares-railway-port-fix] persisted config patch failed:', e.message);
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
  "reload: { mode: 'hybrid', debounceMs: 300 },\n    },\n    discovery: { mdns: { mode: 'off' } },"
);
code = code.replace(
  "const child = spawn('node', ['openclaw.mjs', 'gateway', '--port', String(gatewayPort), '--verbose'],",
  "const child = spawn('node', ['openclaw.mjs', 'gateway', '--port', String(process.env.PORT || gatewayPort), '--verbose'],"
);

fs.writeFileSync(patched, code);
await import(pathToFileURL(patched).href);
