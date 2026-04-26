#!/usr/bin/env node
// Thin wrapper — patches are now applied directly in ares-railway-start.mjs.
// Kept for railway.json startCommand compatibility.
await import('./ares-railway-start.mjs');
