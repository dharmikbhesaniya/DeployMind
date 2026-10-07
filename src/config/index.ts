import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const DATA_DIR = process.env.DEPLOYMIND_DATA_DIR || process.env.DEPLOYAGENT_DATA_DIR || path.resolve(process.cwd(), '.data');

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

  const keyPath = path.join(DATA_DIR, 'master.key');
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  dataDir: DATA_DIR,
  dbPath: process.env.DEPLOYMIND_DB_PATH || process.env.DEPLOYAGENT_DB_PATH || path.join(DATA_DIR, 'deploymind.sqlite'),
  masterKey: resolveMasterKey(),

  docker: {
    socketPath:
      process.env.DOCKER_SOCKET_PATH ||
      (process.platform === 'darwin' &&
      fs.existsSync(path.join(process.env.HOME || '', '.docker/run/docker.sock'))
        ? path.join(process.env.HOME || '', '.docker/run/docker.sock')
        : '/var/run/docker.sock'),
  },

  proxy: {
    provider: (process.env.PROXY_PROVIDER || 'caddy') as 'caddy' | 'traefik',
    caddyApiUrl: process.env.CADDY_API_URL || 'http://127.0.0.1:2019',
    traefikDynamicDir: process.env.TRAEFIK_DYNAMIC_DIR || path.join(DATA_DIR, 'traefik', 'dynamic'),
    baseDomain: process.env.BASE_DOMAIN || 'localhost',
  },

  ai: {
    provider: (process.env.AI_PROVIDER || 'openai') as 'openai' | 'anthropic' | 'gemini' | 'ollama',
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4o',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  },
};
