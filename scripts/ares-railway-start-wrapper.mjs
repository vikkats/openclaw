#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const source = path.resolve('scripts/ares-railway-start.mjs');
const patched = path.resolve('/tmp/ares-railway-start.patched.mjs');
let code = fs.readFileSync(source, 'utf8');

code = code.replace(
  "['openclaw.mjs', 'gateway', '--host', gatewayHost, '--port', String(gatewayPort), '--verbose']",
  "['openclaw.mjs', 'gateway', '--port', String(gatewayPort), '--verbose']"
);

fs.writeFileSync(patched, code);
await import(pathToFileURL(patched).href);
