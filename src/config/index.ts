import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { CONSTANTS } from './constants.js';

// Load variables from .env file into process.env
dotenv.config();

const DATA_DIR =
  process.env.DEPLOYMIND_DATA_DIR ||
  process.env.DEPLOYAGENT_DATA_DIR ||
  path.resolve(process.cwd(), CONSTANTS.APP.DEFAULT_DATA_DIR);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Master encryption key for AES-256-GCM vault
function resolveMasterKey(): Buffer {
  const masterKeyEnv = process.env.DEPLOYMIND_MASTER_KEY || process.env.DEPLOYAGENT_MASTER_KEY;
  if (masterKeyEnv) {
    const raw = masterKeyEnv;
    return raw.length === 64
      ? Buffer.from(raw, 'hex')
      : crypto.createHash('sha256').update(raw).digest();
  }

  const keyPath = path.join(DATA_DIR, CONSTANTS.APP.DEFAULT_MASTER_KEY_FILE);
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  const generated = crypto.randomBytes(CONSTANTS.SECURITY.AES_KEY_BYTES);
  fs.writeFileSync(keyPath, generated, { mode: CONSTANTS.SECURITY.DEFAULT_KEY_FILE_PERMISSIONS });
  return generated;
}

export const config = {
  // Application Core
  appName: process.env.APP_NAME || CONSTANTS.APP.NAME,
  env: process.env.NODE_ENV || CONSTANTS.APP.DEFAULT_ENV,
  port: parseInt(process.env.PORT || String(CONSTANTS.APP.DEFAULT_PORT), 10),
  host: process.env.HOST || CONSTANTS.APP.DEFAULT_HOST,
  dataDir: DATA_DIR,
  dbPath:
    process.env.DEPLOYMIND_DB_PATH ||
    process.env.DEPLOYAGENT_DB_PATH ||
    path.join(DATA_DIR, CONSTANTS.APP.DEFAULT_DB_FILE),
  masterKey: resolveMasterKey(),

  // Docker Container Engine
  docker: {
    socketPath:
      process.env.DOCKER_SOCKET_PATH ||
      (process.platform === 'darwin' &&
      fs.existsSync(path.join(process.env.HOME || '', CONSTANTS.DOCKER.SOCKET_PATHS.DARWIN_USER_DEFAULT))
        ? path.join(process.env.HOME || '', CONSTANTS.DOCKER.SOCKET_PATHS.DARWIN_USER_DEFAULT)
        : CONSTANTS.DOCKER.SOCKET_PATHS.UNIX_DEFAULT),
    networkName: process.env.DOCKER_NETWORK_NAME || CONSTANTS.DOCKER.DEFAULT_NETWORK_NAME,
    containerPrefix: process.env.CONTAINER_NAME_PREFIX || CONSTANTS.DOCKER.CONTAINER_NAME_PREFIX,
    stopTimeoutSeconds: parseInt(
      process.env.DOCKER_STOP_TIMEOUT_SECONDS || String(CONSTANTS.DOCKER.DEFAULT_STOP_TIMEOUT_SECONDS),
      10
    ),
  },

  // Reverse Proxy & Ingress
  proxy: {
    provider: (process.env.PROXY_PROVIDER || CONSTANTS.PROXY.DEFAULT_PROVIDER) as 'caddy' | 'traefik',
    caddyApiUrl: process.env.CADDY_API_URL || CONSTANTS.PROXY.CADDY.DEFAULT_API_URL,
    caddyContainerName: process.env.CADDY_CONTAINER_NAME || CONSTANTS.PROXY.CADDY.DEFAULT_CONTAINER_NAME,
    traefikDynamicDir:
      process.env.TRAEFIK_DYNAMIC_DIR || path.join(DATA_DIR, CONSTANTS.PROXY.TRAEFIK.DYNAMIC_SUBDIR),
    baseDomain: process.env.BASE_DOMAIN || CONSTANTS.PROXY.DEFAULT_BASE_DOMAIN,
  },

  // Artificial Intelligence Systems
  ai: {
    provider: (process.env.AI_PROVIDER || CONSTANTS.AI.DEFAULT_PROVIDER) as
      | 'openai'
      | 'anthropic'
      | 'gemini'
      | 'ollama',
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.AI_MODEL || process.env.OPENAI_MODEL || CONSTANTS.AI.DEFAULT_MODEL,
    openaiApiUrl: process.env.OPENAI_API_URL || CONSTANTS.AI.OPENAI.DEFAULT_API_URL,
    openaiTimeoutMs: parseInt(
      process.env.OPENAI_TIMEOUT_MS || String(CONSTANTS.AI.OPENAI.DEFAULT_TIMEOUT_MS),
      10
    ),
    openaiTemperature: parseFloat(
      process.env.OPENAI_TEMPERATURE || String(CONSTANTS.AI.OPENAI.DEFAULT_TEMPERATURE)
    ),
    openaiMaxTokens: parseInt(
      process.env.OPENAI_MAX_TOKENS || String(CONSTANTS.AI.OPENAI.DEFAULT_MAX_TOKENS),
      10
    ),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || CONSTANTS.AI.OLLAMA.DEFAULT_BASE_URL,
    ollamaModel: process.env.OLLAMA_MODEL || CONSTANTS.AI.OLLAMA.DEFAULT_MODEL,
    typesafe: {
      apiKey: process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '',
      apiUrl:
        process.env.JEV_API_URL ||
        process.env.TYPESAFE_API_URL ||
        CONSTANTS.AI.TYPESAFE_JEV.DEFAULT_API_URL,
      timeoutMs: parseInt(
        process.env.JEV_TIMEOUT_MS || String(CONSTANTS.AI.TYPESAFE_JEV.DEFAULT_TIMEOUT_MS),
        10
      ),
    },
  },

  // Git Repository Cloner
  git: {
    defaultBranch: process.env.GIT_DEFAULT_BRANCH || CONSTANTS.GIT.DEFAULT_BRANCH,
    cloneTimeoutMs: parseInt(
      process.env.GIT_CLONE_TIMEOUT_MS || String(CONSTANTS.GIT.CLONE_TIMEOUT_MS),
      10
    ),
    pullTimeoutMs: parseInt(
      process.env.GIT_PULL_TIMEOUT_MS || String(CONSTANTS.GIT.PULL_TIMEOUT_MS),
      10
    ),
    checkoutTimeoutMs: parseInt(
      process.env.GIT_CHECKOUT_TIMEOUT_MS || String(CONSTANTS.GIT.CHECKOUT_TIMEOUT_MS),
      10
    ),
  },

  // Health Observer & Autonomous Healer
  health: {
    probeTimeoutMs: parseInt(
      process.env.HEALTH_CHECK_TIMEOUT_MS || String(CONSTANTS.HEALTH.PROBE_TIMEOUT_MS),
      10
    ),
    maxRetries: parseInt(
      process.env.HEALTH_CHECK_MAX_RETRIES || String(CONSTANTS.HEALTH.PROBE_MAX_RETRIES),
      10
    ),
    retryIntervalMs: parseInt(
      process.env.HEALTH_CHECK_INTERVAL_MS || String(CONSTANTS.HEALTH.PROBE_RETRY_INTERVAL_MS),
      10
    ),
  },

  // Telemetry & Logs Retention
  logs: {
    retentionDays: parseInt(
      process.env.LOG_RETENTION_DAYS || String(CONSTANTS.LOGS.RETENTION_DAYS),
      10
    ),
    tailLines: parseInt(
      process.env.LOG_DEFAULT_TAIL_LINES || String(CONSTANTS.LOGS.DEFAULT_TAIL_LINES),
      10
    ),
  },
};

export { CONSTANTS };
