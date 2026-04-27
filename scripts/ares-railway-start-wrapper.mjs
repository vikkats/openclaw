#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const configPath = process.env.OPENCLAW_CONFIG_PATH || '/data/.openclaw/openclaw.json';

try {
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let changed = false;

    if (cfg.gateway && Object.prototype.hasOwnProperty.call(cfg.gateway, 'host')) {
      delete cfg.gateway.host;
      changed = true;
      console.log('[ares-railway-wrapper] removed gateway.host from persisted config');
    }

    cfg.discovery = cfg.discovery || {};
    cfg.discovery.mdns = { ...(cfg.discovery.mdns || {}), mode: 'off' };
    changed = true;

    if (changed) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
      console.log('[ares-railway-wrapper] disabled mDNS discovery in persisted config');
    }
  }
} catch (e) {
  console.error('[ares-railway-wrapper] preflight config patch failed:', e.message);
}

await import('./ares-railway-start.mjs');
