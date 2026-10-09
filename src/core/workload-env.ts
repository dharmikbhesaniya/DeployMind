/**
 * Workload Environment Isolation Helper
 *
 * Protects host secrets and DeployMind credentials from leaking into repository-controlled commands,
 * child processes, build scripts, tests, or application runtimes.
 */

export function buildSanitizedWorkloadEnv(
  customEnv?: Record<string, string>,
  overrides?: Record<string, string>
): Record<string, string> {
  // Whitelist only safe host environment variables required for basic OS/tool execution
  const SAFE_HOST_KEYS = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SHELL',
    'TERM',
    'USER',
  ];

  const sanitized: Record<string, string> = {};
  for (const key of SAFE_HOST_KEYS) {
    if (process.env[key] !== undefined) {
      sanitized[key] = process.env[key]!;
    }
  }

  // Ensure standard PATH search directories are present
  const defaultPaths = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  sanitized.PATH = sanitized.PATH ? `${sanitized.PATH}:${defaultPaths}` : defaultPaths;

  // Safe baseline defaults for isolated workloads
  sanitized.NODE_ENV = 'production';
  sanitized.CI = 'true';
  sanitized.PYTHONUNBUFFERED = '1';
  sanitized.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  sanitized.CSC_LINK = '';
  sanitized.CSC_KEY_PASSWORD = '';
  sanitized.CODE_SIGN_IDENTITY = '-';
  sanitized.CODE_SIGNING_REQUIRED = 'NO';
  sanitized.CODE_SIGNING_ALLOWED = 'NO';
  sanitized.ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES = 'true';

  // Merge workload-specific variables (e.g. from Project Vault)
  if (customEnv) {
    for (const [k, v] of Object.entries(customEnv)) {
      if (v !== undefined && v !== null) {
        sanitized[k] = String(v);
      }
    }
  }

  // Merge direct overrides (e.g. PORT)
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined && v !== null) {
        sanitized[k] = String(v);
      }
    }
  }

  // Explicitly strip any sensitive host/DeployMind server keys in case customEnv accidentally collided
  const SENSITIVE_HOST_KEYS = [
    'DEPLOYMIND_MASTER_KEY',
    'DEPLOYAGENT_MASTER_KEY',
    'DEPLOYMIND_ADMIN_TOKEN',
    'VAULT_MASTER_KEY',
    'OPENAI_API_KEY',
    'AI_API_KEY',
    'ANTHROPIC_API_KEY',
    'TYPESAFE_API_KEY',
    'JEV_API_KEY',
    'SESSION_SECRET',
    'JWT_SECRET',
  ];

  for (const key of SENSITIVE_HOST_KEYS) {
    // If the workload env has the exact same value as DeployMind host's secret, strip it!
    if (process.env[key] && sanitized[key] === process.env[key]) {
      delete sanitized[key];
    }
  }

  return sanitized;
}
