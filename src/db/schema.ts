import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  repoUrl: text('repo_url').notNull(),
  branch: text('branch').notNull().default('main'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const deployments = sqliteTable('deployments', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  commitHash: text('commit_hash'),
  status: text('status').notNull(), // 'analyzing' | 'plan_ready' | 'deploying' | 'healthy' | 'failed'
  rawManifest: text('raw_manifest').notNull(), // JSON
  deploymentPlan: text('deployment_plan').notNull(), // JSON
  logs: text('logs'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const services = sqliteTable('services', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  containerId: text('container_id'),
  imageTag: text('image_tag').notNull(),
  internalPort: integer('internal_port').notNull(),
  desiredState: text('desired_state').notNull().default('running'),
  actualState: text('actual_state').notNull().default('unknown'),
  resourceLimits: text('resource_limits').notNull(), // JSON: { cpu, memoryMb }
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const vaultCredentials = sqliteTable('vault_credentials', {
  id: text('id').primaryKey(), // UUID
  keyName: text('key_name').notNull(), // e.g., 'OPENAI_API_KEY' (duplicates allowed)
  description: text('description').notNull(), // e.g., 'Production GPT-4o Key (Client Alpha)'
  maskedPreview: text('masked_preview').notNull(), // e.g., 'sk-proj-...8a1F'
  encryptedValue: text('encrypted_value').notNull(), // AES-256-GCM ciphertext
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  scope: text('scope').notNull().default('GLOBAL'), // 'GLOBAL' | 'PROJECT_SCOPED'
  owningProjectId: text('owning_project_id').references(() => projects.id, {
    onDelete: 'set null',
  }),
  isSystemGenerated: integer('is_system_generated', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const projectCredentialBindings = sqliteTable('project_credential_bindings', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  serviceId: text('service_id').references(() => services.id, { onDelete: 'cascade' }),
  targetEnvVar: text('target_env_var').notNull(),
  vaultCredentialId: text('vault_credential_id')
    .notNull()
    .references(() => vaultCredentials.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at').notNull(),
});

export const domains = sqliteTable('domains', {
  id: text('id').primaryKey(),
  serviceId: text('service_id')
    .notNull()
    .references(() => services.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull().unique(),
  proxyProvider: text('proxy_provider').notNull().default('caddy'), // 'caddy' | 'traefik'
  routeIdentifier: text('route_identifier').notNull().unique(),
  sslActive: integer('ssl_active', { mode: 'boolean' }).notNull().default(false),
  targetUpstream: text('target_upstream').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sharedResources = sqliteTable('shared_resources', {
  id: text('id').primaryKey(),
  resourceType: text('resource_type').notNull(), // 'postgres' | 'redis' | 'minio'
  containerName: text('container_name').notNull(),
  hostPort: integer('host_port').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  metadata: text('metadata').notNull(), // JSON configuration
});

export const resourceTenants = sqliteTable('resource_tenants', {
  id: text('id').primaryKey(),
  resourceId: text('resource_id')
    .notNull()
    .references(() => sharedResources.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  databaseName: text('database_name'),
  username: text('username').notNull(),
  encryptedCredentials: text('encrypted_credentials').notNull(),
  createdAt: integer('created_at').notNull(),
});
