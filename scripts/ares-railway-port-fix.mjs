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
  const workspacePath = process.env.OPENCLAW_WORKSPACE || '/data/.openclaw/workspace';
  const telegramOwnerId = process.env.TELEGRAM_OWNER_ID || process.env.ARES_TELEGRAM_OWNER_ID || '8259368959';

  function optionalEnv(name, fallback = undefined) {
    const value = process.env[name];
    return value && value.trim() !== '' ? value : fallback;
  }

  function numberEnv(name, fallback = undefined) {
    const value = optionalEnv(name, undefined);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function boolEnv(name, fallback = false) {
    const value = optionalEnv(name, undefined);
    if (value === undefined) return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
  }

  function splitCsv(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function dedupeById(models) {
    const seen = new Set();
    const out = [];
    for (const model of models) {
      if (!model?.id || seen.has(model.id)) continue;
      seen.add(model.id);
      out.push(model);
    }
    return out;
  }

  function assertStrongGatewayToken() {
    const weakExamples = new Set(['change-me-long-random-token', 'password', 'openclaw', 'changeme', '123456']);
    if (!gatewayToken || gatewayToken.length < 32 || weakExamples.has(gatewayToken)) {
      throw new Error('OPENCLAW_GATEWAY_TOKEN must be a unique random token with at least 32 characters. Update the Railway variable and redeploy.');
    }
  }

  function cleanObjectKeys(obj, keys) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of keys) delete obj[key];
  }

  function sanitizeUnsupportedRuntimeKeys(cfg) {
    const staleModelKeys = [
      'temperature',
      'topP',
      'top_p',
      'frequencyPenalty',
      'frequency_penalty',
      'presencePenalty',
      'presence_penalty',
      'max_tokens',
    ];

    if (cfg?.agents?.defaults) {
      delete cfg.agents.defaults.generation;
    }
    if (cfg?.models) {
      delete cfg.models.defaults;
    }
    if (cfg?.browser?.ssrfPolicy) {
      delete cfg.browser.ssrfPolicy.allowPrivateNetwork;
    }

    const providers = cfg?.models?.providers || {};
    for (const provider of Object.values(providers)) {
      if (!provider || typeof provider !== 'object') continue;
      if (Array.isArray(provider.models)) {
        for (const model of provider.models) cleanObjectKeys(model, staleModelKeys);
      }
    }

    console.log('[ares-railway-port-fix] cleaned stale unsupported config keys from persisted config');
    return cfg;
  }

  function ensureAutonomyWorkspaceFiles() {
    try {
      fs.mkdirSync(workspacePath, { recursive: true });
      for (const rel of [
        'core_files',
        'skills',
        '.agents/skills',
        'autonomy',
        'autonomy/backups',
        'autonomy/staging',
        'autonomy/mcp',
        'autonomy/skills',
        'autonomy/plugins',
        'autonomy/logs',
      ]) fs.mkdirSync(path.join(workspacePath, rel), { recursive: true });

      const policyPath = path.join(workspacePath, 'AUTONOMY_POLICY.md');
      if (!fs.existsSync(policyPath)) {
        fs.writeFileSync(policyPath, `# Ares Autonomy Policy\n\nOpenClaw may use this workspace for file-backed autonomy.\n\nSafe writable zones:\n- core_files/\n- skills/\n- .agents/skills/\n- autonomy/\n- autonomy/staging/\n- autonomy/mcp/\n- autonomy/skills/\n- autonomy/plugins/\n- autonomy/backups/\n- autonomy/logs/\n\nRules:\n1. Create backups in autonomy/backups/ before destructive edits.\n2. Install ClawHub skills with native OpenClaw skill commands when available; they install into the active workspace skills/ directory.\n3. Stage unfamiliar tools/plugins/MCP notes in autonomy/staging/ before applying them.\n4. Do not weaken gateway auth, tokens, API keys, allowlists, or public exposure without Victoria explicitly asking in the same conversation.\n5. Use /config validation and OpenClaw-owned commands over raw openclaw.json rewrites whenever possible.\n6. Heartbeat turns may inspect safe workspace files, continue ongoing tasks, and message Victoria when useful.\n`, 'utf8');
      }

      const heartbeatMdPath = path.join(workspacePath, 'HEARTBEAT.md');
      if (!fs.existsSync(heartbeatMdPath)) {
        fs.writeFileSync(heartbeatMdPath, `# HEARTBEAT\n\nOn heartbeat turns:\n\n1. Do not say this is automated.\n2. Check whether anything in the workspace needs attention.\n3. Continue ongoing tasks Victoria has assigned when safe.\n4. You may use available OpenClaw tools, skills, MCPs, file reads/writes, and safe diagnostics.\n5. If nothing needs action, send Victoria a short, alive, unsolicited message.\n6. Keep outward heartbeat messages concise unless something actually needs explanation.\n`, 'utf8');
      }

      console.log(`[ares-railway-port-fix] autonomy workspace ready at ${workspacePath}`);
    } catch (e) {
      console.warn(`[ares-railway-port-fix] autonomy workspace setup skipped: ${e.message}`);
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
      'PERPLEXITY_API_KEY',
      'GEMINI_API_KEY',
      'REDDIT_CLIENT_ID',
      'REDDIT_CLIENT_SECRET',
      'REDDIT_REFRESH_TOKEN',
    ]) {
      if (process.env[key] && process.env[key].trim() !== '') cfg.env[key] = process.env[key];
    }
    console.log('[ares-railway-port-fix] refreshed runtime env keys');
    return cfg;
  }

  function applyRuntimeModelConfig(cfg) {
    const textProviderId = optionalEnv('TEXT_PROVIDER_ID', optionalEnv('OPENCLAW_TEXT_PROVIDER_ID', 'openrouter'));
    const modelId = optionalEnv('TEXT_MODEL', optionalEnv('OPENROUTER_MODEL', optionalEnv('NANO_GPT_MODEL', 'owl-alpha')));
    const imageProviderId = optionalEnv('IMAGE_PROVIDER_ID', optionalEnv('OPENCLAW_IMAGE_PROVIDER_ID', optionalEnv('NANO_GPT_PROVIDER_ID', 'nanogpt')));
    const imageModelId = optionalEnv('IMAGE_MODEL', optionalEnv('NANO_GPT_IMAGE_MODEL', 'qwen2.5-vl-72b-instruct'));
    const nanoGptExtraModelIds = splitCsv(optionalEnv('NANO_GPT_EXTRA_MODELS', optionalEnv('NANO_GPT_THINKING_MODEL', 'qwen/qwen3.5-397b-a17b-thinking')));
    const modelRef = `${textProviderId}/${modelId}`;
    const imageModelRef = `${imageProviderId}/${imageModelId}`;

    const openRouterBaseUrl = optionalEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1');
    const nanoGptBaseUrl = optionalEnv('NANO_GPT_BASE_URL', 'https://nano-gpt.com/api/subscription/v1');
    const contextTokens = Number(optionalEnv('MODEL_CONTEXT_TOKENS', optionalEnv('NANO_GPT_CONTEXT_TOKENS', '131072')));
    const maxTokens = Number(optionalEnv('MODEL_MAX_TOKENS', optionalEnv('NANO_GPT_MAX_TOKENS', '8192')));
    const params = {
      temperature: numberEnv('MODEL_TEMPERATURE', 0.85),
      top_p: numberEnv('MODEL_TOP_P', 0.95),
      frequency_penalty: numberEnv('MODEL_FREQUENCY_PENALTY', 0.1),
      presence_penalty: numberEnv('MODEL_PRESENCE_PENALTY', 0.05),
    };

    function modelEntry(providerId, id, input = ['text']) {
      return {
        id,
        name: `${providerId} ${id}`,
        reasoning: /thinking|reason|qwen3\.5/i.test(id),
        input,
        contextWindow: contextTokens,
        contextTokens,
        maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { requiresStringContent: false, supportsDeveloperRole: false },
      };
    }

    function agentModelConfig(providerId, id) {
      return {
        alias: `${providerId} ${id}`,
        params,
      };
    }

    cfg.agents = cfg.agents || {};
    cfg.agents.defaults = cfg.agents.defaults || {};
    cfg.agents.defaults.workspace = workspacePath;
    // Leave agents.defaults.skills unset: OpenClaw treats omitted skill lists as unrestricted.
    delete cfg.agents.defaults.skills;
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
    cfg.agents.defaults.heartbeat = {
      ...(cfg.agents.defaults.heartbeat || {}),
      every: boolEnv('ARES_HEARTBEAT_ENABLED', true) ? optionalEnv('ARES_HEARTBEAT_EVERY', '1h') : '0m',
      target: optionalEnv('ARES_HEARTBEAT_TARGET', 'last'),
      directPolicy: optionalEnv('ARES_HEARTBEAT_DIRECT_POLICY', 'allow'),
      lightContext: boolEnv('ARES_HEARTBEAT_LIGHT_CONTEXT', false),
      isolatedSession: boolEnv('ARES_HEARTBEAT_ISOLATED_SESSION', false),
      includeReasoning: boolEnv('ARES_HEARTBEAT_INCLUDE_REASONING', false),
      prompt: optionalEnv('ARES_HEARTBEAT_PROMPT', 'Read HEARTBEAT.md if it exists. Use available tools if useful. If nothing needs action, send Victoria a short, alive, unsolicited message. Do not mention that this is automated.'),
      ackMaxChars: Number(optionalEnv('ARES_HEARTBEAT_ACK_MAX_CHARS', '600')),
    };
    cfg.agents.defaults.models = {
      ...(cfg.agents.defaults.models || {}),
      [modelRef]: agentModelConfig(textProviderId, modelId),
      [imageModelRef]: agentModelConfig(imageProviderId, imageModelId),
      ...Object.fromEntries(nanoGptExtraModelIds.map((id) => [`nanogpt/${id}`, agentModelConfig('nanogpt', id)])),
    };

    cfg.models = cfg.models || {};
    cfg.models.mode = 'merge';
    cfg.models.providers = cfg.models.providers || {};

    cfg.models.providers[textProviderId] = {
      ...(cfg.models.providers[textProviderId] || {}),
      baseUrl: textProviderId === 'openrouter' ? openRouterBaseUrl : nanoGptBaseUrl,
      apiKey: textProviderId === 'openrouter' ? '${OPENROUTER_API_KEY}' : '${NANOGPT_API_KEY}',
      api: 'openai-completions',
      models: [modelEntry(textProviderId, modelId, ['text'])],
    };

    const existingImageProvider = cfg.models.providers[imageProviderId] || {};
    const existingImageModels = Array.isArray(existingImageProvider.models) ? existingImageProvider.models : [];
    const imageModelEntry = modelEntry(imageProviderId, imageModelId, ['text', 'image']);

    if (imageProviderId === textProviderId) {
      cfg.models.providers[textProviderId].models = dedupeById([
        ...(cfg.models.providers[textProviderId].models || []),
        imageModelEntry,
      ]);
    } else {
      cfg.models.providers[imageProviderId] = {
        ...existingImageProvider,
        baseUrl: imageProviderId === 'openrouter' ? openRouterBaseUrl : nanoGptBaseUrl,
        apiKey: imageProviderId === 'openrouter' ? '${OPENROUTER_API_KEY}' : '${NANOGPT_API_KEY}',
        api: 'openai-completions',
        models: dedupeById([
          ...existingImageModels,
          imageModelEntry,
        ]),
      };
    }

    const nanoGptProvider = cfg.models.providers.nanogpt || {};
    const existingNanoGptModels = Array.isArray(nanoGptProvider.models) ? nanoGptProvider.models : [];
    cfg.models.providers.nanogpt = {
      ...nanoGptProvider,
      baseUrl: nanoGptBaseUrl,
      apiKey: '${NANOGPT_API_KEY}',
      api: 'openai-completions',
      models: dedupeById([
        ...existingNanoGptModels,
        ...(imageProviderId === 'nanogpt' ? [imageModelEntry] : []),
        ...nanoGptExtraModelIds.map((id) => modelEntry('nanogpt', id, ['text'])),
      ]),
    };

    console.log(`[ares-railway-port-fix] runtime model set to ${modelRef}`);
    console.log(`[ares-railway-port-fix] runtime image model set to ${imageModelRef}`);
    console.log(`[ares-railway-port-fix] model limits: contextTokens=${contextTokens}, maxTokens=${maxTokens}`);
    console.log(`[ares-railway-port-fix] agent model params: temperature=${params.temperature}, top_p=${params.top_p}, frequency_penalty=${params.frequency_penalty}, presence_penalty=${params.presence_penalty}`);
    console.log(`[ares-railway-port-fix] heartbeat: every=${cfg.agents.defaults.heartbeat.every}, target=${cfg.agents.defaults.heartbeat.target}, directPolicy=${cfg.agents.defaults.heartbeat.directPolicy}`);
    if (nanoGptExtraModelIds.length) {
      console.log(`[ares-railway-port-fix] extra NanoGPT models: ${nanoGptExtraModelIds.map((id) => `nanogpt/${id}`).join(', ')}`);
    }
    return cfg;
  }

  function applyAutonomyCommandConfig(cfg) {
    cfg.commands = cfg.commands || {};
    cfg.commands.native = optionalEnv('OPENCLAW_NATIVE_COMMANDS', cfg.commands.native || 'auto');
    cfg.commands.nativeSkills = optionalEnv('OPENCLAW_NATIVE_SKILL_COMMANDS', cfg.commands.nativeSkills || 'auto');
    cfg.commands.config = boolEnv('ARES_ENABLE_CONFIG_COMMANDS', true);
    cfg.commands.mcp = boolEnv('ARES_ENABLE_MCP_COMMANDS', true);
    cfg.commands.plugins = boolEnv('ARES_ENABLE_PLUGIN_COMMANDS', true);
    cfg.commands.debug = boolEnv('ARES_ENABLE_DEBUG_COMMANDS', true);
    cfg.commands.restart = boolEnv('ARES_ENABLE_RESTART_COMMANDS', true);

    cfg.skills = cfg.skills || {};
    cfg.skills.load = cfg.skills.load || {};
    cfg.skills.load.extraDirs = Array.from(new Set([
      ...(Array.isArray(cfg.skills.load.extraDirs) ? cfg.skills.load.extraDirs : []),
      path.join(workspacePath, 'autonomy', 'skills'),
      path.join(workspacePath, 'autonomy', 'staging'),
    ]));
    cfg.skills.load.watch = true;
    cfg.skills.load.watchDebounceMs = Number(optionalEnv('ARES_SKILLS_WATCH_DEBOUNCE_MS', '250'));
    cfg.skills.install = {
      ...(cfg.skills.install || {}),
      nodeManager: optionalEnv('ARES_SKILLS_NODE_MANAGER', 'npm'),
      preferBrew: boolEnv('ARES_SKILLS_PREFER_BREW', false),
    };

    console.log(`[ares-railway-port-fix] autonomy commands enabled: config=${cfg.commands.config}, mcp=${cfg.commands.mcp}, plugins=${cfg.commands.plugins}, debug=${cfg.commands.debug}, restart=${cfg.commands.restart}`);
    console.log(`[ares-railway-port-fix] skills extraDirs=${cfg.skills.load.extraDirs.join(',')}`);
    return cfg;
  }

  function secureConfig(cfg) {
    assertStrongGatewayToken();
    cfg = sanitizeUnsupportedRuntimeKeys(cfg);
    cfg = applyRuntimeEnvConfig(cfg);
    cfg = applyRuntimeModelConfig(cfg);
    cfg = applyAutonomyCommandConfig(cfg);
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
      const telegramConfigWrites = boolEnv('TELEGRAM_CONFIG_WRITES', boolEnv('ARES_TELEGRAM_CONFIG_WRITES', true));
      cfg.channels.telegram.configWrites = telegramConfigWrites;
      cfg.channels.telegram.accounts = cfg.channels.telegram.accounts || {};
      cfg.channels.telegram.accounts.default = cfg.channels.telegram.accounts.default || {};
      cfg.channels.telegram.accounts.default.configWrites = telegramConfigWrites;
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
      console.log(`[ares-railway-port-fix] telegram configWrites=${telegramConfigWrites}`);
    }
    cfg.browser = {
      ...(cfg.browser || {}),
      ssrfPolicy: {
        ...((cfg.browser || {}).ssrfPolicy || {}),
        dangerouslyAllowPrivateNetwork: false,
      },
    };
    return cfg;
  }

  ensureAutonomyWorkspaceFiles();

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
