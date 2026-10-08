import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config/index.js';
import * as schema from './schema.js';

export const sqlite: BetterSqlite3Database = new Database(config.dbPath);

// Enable WAL mode for high concurrency
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// Initialize tables if they do not exist
export function initDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      repo_url TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      commit_hash TEXT,
      status TEXT NOT NULL,
      raw_manifest TEXT NOT NULL,
      deployment_plan TEXT NOT NULL,
      logs TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      container_id TEXT,
      image_tag TEXT NOT NULL,
      internal_port INTEGER NOT NULL,
      desired_state TEXT NOT NULL DEFAULT 'running',
      actual_state TEXT NOT NULL DEFAULT 'unknown',
      resource_limits TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vault_credentials (
      id TEXT PRIMARY KEY,
      key_name TEXT NOT NULL,
      description TEXT NOT NULL,
      masked_preview TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'GLOBAL',
      owning_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      is_system_generated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_credential_bindings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
      target_env_var TEXT NOT NULL,
      vault_credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, target_env_var)
    );

    CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      hostname TEXT NOT NULL UNIQUE,
      proxy_provider TEXT NOT NULL DEFAULT 'caddy',
      route_identifier TEXT NOT NULL UNIQUE,
      ssl_active INTEGER NOT NULL DEFAULT 0,
      target_upstream TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shared_resources (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      container_name TEXT NOT NULL,
      host_port INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_tenants (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL REFERENCES shared_resources(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      database_name TEXT,
      username TEXT NOT NULL,
      encrypted_credentials TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

export const db = drizzle(sqlite, { schema });
export { schema };
