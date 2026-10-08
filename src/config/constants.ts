/**
 * DeployMind System Constants
 * Centralized registry of application constants and default configuration values.
 * All default operational parameters are specified here to avoid hardcoded literals.
 */

export const CONSTANTS = {
  // Application Meta
  APP: {
    NAME: 'DeployMind',
    DEFAULT_ENV: 'development',
    DEFAULT_PORT: 3000,
    DEFAULT_HOST: '0.0.0.0',
    DEFAULT_DATA_DIR: '.data',
    DEFAULT_DB_FILE: 'deploymind.sqlite',
    DEFAULT_MASTER_KEY_FILE: 'master.key',
  },

  // Ingress & Reverse Proxy
  PROXY: {
    DEFAULT_PROVIDER: 'caddy' as const,
    DEFAULT_BASE_DOMAIN: 'localhost',
    CADDY: {
      DEFAULT_API_URL: 'http://127.0.0.1:2019',
      DEFAULT_CONTAINER_NAME: 'deploymind-caddy',
      ADMIN_PORT: 2019,
      HTTP_PORT: 80,
      HTTPS_PORT: 443,
    },
    TRAEFIK: {
      DYNAMIC_SUBDIR: 'traefik/dynamic',
    },
  },

  // Docker Container Engine
  DOCKER: {
    DEFAULT_NETWORK_NAME: 'deploymind-net',
    CONTAINER_NAME_PREFIX: 'app_proj_',
    DEFAULT_STOP_TIMEOUT_SECONDS: 10,
    SOCKET_PATHS: {
      UNIX_DEFAULT: '/var/run/docker.sock',
      DARWIN_USER_DEFAULT: '.docker/run/docker.sock',
    },
  },

  // Artificial Intelligence: System 1 (TypeSafe Jev) & System 2 (OpenAI / Claude)
  AI: {
    DEFAULT_PROVIDER: 'openai' as const,
    DEFAULT_MODEL: 'gpt-4o',
    OPENAI: {
      DEFAULT_API_URL: 'https://api.openai.com/v1/chat/completions',
      DEFAULT_TIMEOUT_MS: 15000,
      DEFAULT_TEMPERATURE: 0.3,
      DEFAULT_MAX_TOKENS: 1024,
    },
    TYPESAFE_JEV: {
      DEFAULT_API_URL: 'https://api.typesafe.ai/v1/jev/evaluate',
      DEFAULT_TIMEOUT_MS: 5000,
      HIGH_CONFIDENCE_THRESHOLD: 0.85,
      CALIBRATION_DECISION_CEILING: 0.99,
    },
    OLLAMA: {
      DEFAULT_BASE_URL: 'http://127.0.0.1:11434',
      DEFAULT_MODEL: 'llama3:8b',
    },
  },

  // Git Repository Analyzer & Pipeline
  GIT: {
    DEFAULT_BRANCH: 'main',
    CLONE_TIMEOUT_MS: 120000,
    PULL_TIMEOUT_MS: 60000,
    CHECKOUT_TIMEOUT_MS: 30000,
    DEFAULT_DEPTH: 1,
  },

  // Container Health Observation & Autonomous Healing
  HEALTH: {
    PROBE_TIMEOUT_MS: 4000,
    PROBE_MAX_RETRIES: 6,
    PROBE_RETRY_INTERVAL_MS: 1500,
    HTTP_ROOT_PATH: '/',
    SUCCESS_STATUS_CODES: [200, 201, 202, 204, 301, 302, 307, 308],
  },

  // Telemetry, Logs & Maintenance
  LOGS: {
    RETENTION_DAYS: 7,
    DEFAULT_TAIL_LINES: 100,
    MAX_STREAM_BUFFER_LINES: 1000,
  },

  // Security & Vault
  SECURITY: {
    AES_KEY_BYTES: 32,
    AES_IV_BYTES: 16,
    AES_AUTH_TAG_BYTES: 16,
    DEFAULT_KEY_FILE_PERMISSIONS: 0o600,
  },
} as const;
