#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.ARES_UPLOAD_MODE === '1') {
  console.log('[ares-railway-port-fix] ARES_UPLOAD_MODE=1, starting upload page instead of OpenClaw gateway');
  await import('./ares-upload-server.mjs');
} else {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || '/data/.openclaw/openclaw.json';
  const railwayPort = Number(process.env.PORT || process.env.OPENCLAW_GATEWAY_PORT || 18789);
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';

  function optionalEnv(name, fallback = undefined) {
    const value = process.env[name];
    return value && value.trim() !== '' ? value : fallback;
  }

  function assertStrongGatewayToken() {
    const weakExamples = new Set(['change-me-long-random-token', 'password', 'openclaw', 'changeme', '123456']);
    if (!gatewayToken || gatewayToken.length < 32 || weakExamples.has(gatewayToken)) {
      throw new Error('OPENCLAW_GATEWAY_TOKEN must be a unique random token with at least 32 characters. Update the Railway variable and redeploy.');
    }
  }

  function applyRuntimeEnvConfig(cfg) {
    cfg.env = cfg.env || {};
    for (const key of [
      'NANOGPT_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'QDRANT_URL',
      'QDRANT_API_KEY',
      'OPENROUTER_API_KEY',
    ]) {
      if (process.env[key] && process.env[key].trim() !== '') cfg.env[key] = process.env[key];
    }
    console.log('[ares-railway-port-fix] refreshed runtime env keys: NANOGPT_API_KEY, TELEGRAM_BOT_TOKEN, QDRANT_URL, QDRANT_API_KEY, OPENROUTER_API_KEY');
    return cfg;
  }

  function applyRuntimeModelConfig(cfg) {
    const textProviderId = optionalEnv('TEXT_PROVIDER_ID', optionalEnv('OPENCLAW_TEXT_PROVIDER_ID', 'openrouter'));
    const modelId = optionalEnv('TEXT_MODEL', optionalEnv('OPENROUTER_MODEL', optionalEnv('NANO_GPT_MODEL', 'owl-alpha')));
    const imageProviderId = optionalEnv('IMAGE_PROVIDER_ID', optionalEnv('OPENCLAW_IMAGE_PROVIDER_ID', optionalEnv('NANO_GPT_PROVIDER_ID', 'nanogpt')));
    const imageModelId = optionalEnv('IMAGE_MODEL', optionalEnv('NANO_GPT_IMAGE_MODEL', 'qwen2.5-vl-72b-instruct'));
    const modelRef = `${textProviderId}/${modelId}`;
    const imageModelRef = `${imageProviderId}/${imageModelId}`;

    const openRouterBaseUrl = optionalEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1');
    const nanoGptBaseUrl = optionalEnv('NANO_GPT_BASE_URL', 'https://nano-gpt.com/api/subscription/v1');
    const contextTokens = Number(optionalEnv('MODEL_CONTEXT_TOKENS', optionalEnv('NANO_GPT_CONTEXT_TOKENS', '131072')));
    const maxTokens = Number(optionalEnv('MODEL_MAX_TOKENS', optionalEnv('NANO_GPT_MAX_TOKENS', '8192')));

    cfg.agents = cfg.agents || {};
    cfg.agents.defaults = cfg.agents.defaults || {};
    cfg.agents.defaults.model = {
      ...(cfg.agents.defaults.model || {}),
      primary: modelRef,
      fallbacks: [],
    };
    cfg.agents.defaults.imageModel = {
      ...(cfg.agents.defaults.imageModel || {}),
      primary: imageModelRef,
      fallbacks: [],
    };
    cfg.agents.defaults.models = {
      ...(cfg.agents.defaults.models || {}),
      [modelRef]: { alias: `${textProviderId} ${modelId}` },
      [imageModelRef]: { alias: `${imageProviderId} ${imageModelId}` },
    };

    cfg.models = cfg.models || {};
    cfg.models.mode = 'merge';
    cfg.models.providers = cfg.models.providers || {};

    cfg.models.providers[textProviderId] = {
      ...(cfg.models.providers[textProviderId] || {}),
      baseUrl: textProviderId === 'openrouter' ? openRouterBaseUrl : nanoGptBaseUrl,
      apiKey: textProviderId === 'openrouter' ? '${OPENROUTER_API_KEY}' : '${NANOGPT_API_KEY}',
      api: 'openai-completions',
      models: [
        {
          id: modelId,
          name: `${textProviderId} ${modelId}`,
          reasoning: /thinking|reason/i.test(modelId),
          input: ['text'],
          contextWindow: contextTokens,
          contextTokens,
          maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { requiresStringContent: false, supportsDeveloperRole: false },
        },
      ],
    };

    const existingImageProvider = cfg.models.providers[imageProviderId] || {};
    const existingImageModels = Array.isArray(existingImageProvider.models) ? existingImageProvider.models : [];
    const imageModelEntry = {
      id: imageModelId,
      name: `${imageProviderId} ${imageModelId}`,
      reasoning: /thinking|reason/i.test(imageModelId),
      input: ['text', 'image'],
      contextWindow: contextTokens,
      contextTokens,
      maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { requiresStringContent: false, supportsDeveloperRole: false },
    };

    if (imageProviderId === textProviderId) {
      const deduped = [
        ...(cfg.models.providers[textProviderId].models || []).filter((model) => model.id !== imageModelId),
        imageModelEntry,
      ];
      cfg.models.providers[textProviderId].models = deduped;
    } else {
      cfg.models.providers[imageProviderId] = {
        ...existingImageProvider,
        baseUrl: imageProviderId === 'openrouter' ? openRouterBaseUrl : nanoGptBaseUrl,
        apiKey: imageProviderId === 'openrouter' ? '${OPENROUTER_API_KEY}' : '${NANOGPT_API_KEY}',
        api: 'openai-completions',
        models: [
          ...existingImageModels.filter((model) => model.id !== imageModelId),
          imageModelEntry,
        ],
      };
    }

    console.log(`[ares-railway-port-fix] runtime model set to ${modelRef}`);
    console.log(`[ares-railway-port-fix] runtime image model set to ${imageModelRef}`);
    return cfg;
  }

  function secureConfig(cfg) {
    assertStrongGatewayToken();
    cfg = applyRuntimeEnvConfig(cfg);
    cfg = applyRuntimeModelConfig(cfg);
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
      cfg.channels.telegram.streaming = 'off';
      cfg.channels.telegram.replyToMode = 'off';
      cfg.channels.telegram.linkPreview = false;
      cfg.channels.telegram.textChunkLimit = Number(process.env.TELEGRAM_TEXT_CHUNK_LIMIT || 4000);
      cfg.channels.telegram.chunkMode = 'length';
      cfg.channels.telegram.retry = {
        ...(cfg.channels.telegram.retry || {}),
        attempts: Number(process.env.TELEGRAM_RETRY_ATTEMPTS || 2),
        minDelayMs: Number(process.env.TELEGRAM_RETRY_MIN_DELAY_MS || 500),
        maxDelayMs: Number(process.env.TELEGRAM_RETRY_MAX_DELAY_MS || 5000),
        jitter: 0.1,
      };
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
      console.log(`[ares-railway-port-fix] secured config: port=${railwayPort}, bind=lan, auth=token, mdns=off, hooks=off, telegramStreaming=off`);
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
    "botToken: '${TELEGRAM_BOT_TOKEN}',\n        dmPolicy:",
    "botToken: '${TELEGRAM_BOT_TOKEN}',\n        streaming: 'off',\n        replyToMode: 'off',\n        linkPreview: false,\n        dmPolicy:"
  );
  code = code.replace(
    "const child = spawn('node', ['openclaw.mjs', 'gateway', '--port', String(gatewayPort), '--verbose'],",
    "const child = spawn('node', ['openclaw.mjs', 'gateway', '--port', String(process.env.PORT || gatewayPort), '--verbose'],"
  );
  fs.writeFileSync(patched, code);
  await import(pathToFileURL(patched).href);
}
