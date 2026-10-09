import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, and } from 'drizzle-orm';
import { dockerService } from '../docker/docker.service.js';
import { db, schema } from '../../db/index.js';
import { config } from '../../config/index.js';

export interface TenantCredentials {
  connectionUri: string;
  databaseName?: string;
  username?: string;
  password?: string;
  keyPrefix?: string;
}

export class ResourceManager {
  readonly sharedPostgresName = 'deploymind-shared-postgres';
  readonly sharedRedisName = 'deploymind-shared-redis';

  getPostgresAdminPassword(): string {
    const keyPath = path.resolve(config.dataDir, 'postgres_admin.key');
    try {
      if (fs.existsSync(keyPath)) {
        const secret = fs.readFileSync(keyPath, 'utf8').trim();
        if (secret) return secret;
      }
      const newSecret = crypto.randomBytes(24).toString('hex');
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, newSecret, { mode: 0o600 });
      return newSecret;
    } catch {
      return 'deploymind_pg_sec_admin';
    }
  }

  getRedisAdminPassword(): string {
    const keyPath = path.resolve(config.dataDir, 'redis_admin.key');
    try {
      if (fs.existsSync(keyPath)) {
        const secret = fs.readFileSync(keyPath, 'utf8').trim();
        if (secret) return secret;
      }
      const newSecret = crypto.randomBytes(24).toString('hex');
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, newSecret, { mode: 0o600 });
      return newSecret;
    } catch {
      return 'deploymind_rd_sec_admin';
    }
  }

  // Ensures shared PostgreSQL cluster is available and tracked in DB
  async ensureSharedPostgres(): Promise<string> {
    const isDockerReady = await dockerService.isAvailable();
    const resourceId = 'res_shared_postgres';

    // Track in database
    const [existing] = await db
      .select()
      .from(schema.sharedResources)
      .where(eq(schema.sharedResources.id, resourceId));

    if (!existing) {
      await db.insert(schema.sharedResources).values({
        id: resourceId,
        resourceType: 'postgres',
        containerName: this.sharedPostgresName,
        hostPort: 5432,
        isActive: true,
        metadata: JSON.stringify({ version: '16-alpine', defaultDb: 'postgres' }),
      });
    }

    if (!isDockerReady) return resourceId;

    try {
      const adminPass = this.getPostgresAdminPassword();
      await dockerService.startContainer({
        containerName: this.sharedPostgresName,
        imageTag: 'postgres:16-alpine',
        env: {
          POSTGRES_USER: 'deploymind_admin',
          POSTGRES_PASSWORD: adminPass,
          POSTGRES_DB: 'postgres',
        },
        exposedPort: 5432,
        memoryLimitMb: 512,
        volumes: [
          {
            hostVolumeName: 'deploymind-postgres-data',
            containerPath: '/var/lib/postgresql/data',
          },
        ],
        networkAliases: ['postgres', 'shared-postgres', 'db'],
        labels: {
          'deploymind.managed': 'true',
          'deploymind.resource_type': 'shared_postgres',
        },
      });
    } catch {
      // Container may already be running
    }

    return resourceId;
  }

  // Ensures shared Redis cluster is available and tracked in DB
  async ensureSharedRedis(): Promise<string> {
    const isDockerReady = await dockerService.isAvailable();
    const resourceId = 'res_shared_redis';

    const [existing] = await db
      .select()
      .from(schema.sharedResources)
      .where(eq(schema.sharedResources.id, resourceId));

    if (!existing) {
      await db.insert(schema.sharedResources).values({
        id: resourceId,
        resourceType: 'redis',
        containerName: this.sharedRedisName,
        hostPort: 6379,
        isActive: true,
        metadata: JSON.stringify({ version: '7-alpine' }),
      });
    }

    if (!isDockerReady) return resourceId;

    try {
      const redisAdminPass = this.getRedisAdminPassword();
      await dockerService.startContainer({
        containerName: this.sharedRedisName,
        imageTag: 'redis:7-alpine',
        cmd: ['redis-server', '--requirepass', redisAdminPass, '--appendonly', 'yes'],
        env: {},
        exposedPort: 6379,
        memoryLimitMb: 256,
        volumes: [
          {
            hostVolumeName: 'deploymind-redis-data',
            containerPath: '/data',
          },
        ],
        networkAliases: ['redis', 'shared-redis'],
        labels: {
          'deploymind.managed': 'true',
          'deploymind.resource_type': 'shared_redis',
        },
      });
    } catch {
      // Container may already be running
    }

    return resourceId;
  }

  // Provisions an isolated tenant database & user in shared PostgreSQL and tracks tenant binding
  async provisionPostgresTenant(projectId: string): Promise<TenantCredentials> {
    const resourceId = await this.ensureSharedPostgres();

    const cleanId = projectId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const dbName = `db_${cleanId}`;
    const username = `usr_${cleanId}`;
    const password = crypto.randomBytes(16).toString('hex');

    const isRunning = await dockerService.isContainerRunning(this.sharedPostgresName);
    if (isRunning) {
      const sqlCommands = `
        DO \\$\\$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${username}') THEN
            CREATE USER ${username} WITH PASSWORD '${password}';
          END IF;
        END
        \\$\\$;
        SELECT 'CREATE DATABASE ${dbName} OWNER ${username}'
        WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${dbName}')\\gexec
        REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC;
        GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${username};
      `;

      try {
        const execRes = await dockerService.execCommand(this.sharedPostgresName, [
          'psql',
          '-U',
          'deploymind_admin',
          '-d',
          'postgres',
          '-c',
          sqlCommands,
        ]);
        if (execRes && execRes.exitCode !== 0) {
          throw new Error(`psql returned exit code ${execRes.exitCode}: ${execRes.output}`);
        }
      } catch (err: any) {
        console.error('[ResourceManager] Error provisioning tenant in shared Postgres:', err);
        throw new Error(`Failed to provision isolated PostgreSQL tenant: ${err?.message || err}`);
      }
    } else if (process.env.NODE_ENV !== 'test') {
      const isDockerReady = await dockerService.isAvailable();
      if (isDockerReady) {
        throw new Error(`Shared PostgreSQL container is not running. Cannot provision tenant.`);
      }
    }

    const connectionUri = `postgresql://${username}:${password}@${this.sharedPostgresName}:5432/${dbName}`;

    // Record or update tenant in DB
    const tenantId = `ten_pg_${projectId.slice(0, 16)}`;
    await db
      .delete(schema.resourceTenants)
      .where(
        and(
          eq(schema.resourceTenants.projectId, projectId),
          eq(schema.resourceTenants.resourceId, resourceId)
        )
      );

    await db.insert(schema.resourceTenants).values({
      id: tenantId,
      resourceId,
      projectId,
      databaseName: dbName,
      username,
      encryptedCredentials: JSON.stringify({ connectionUri, password }),
      createdAt: Date.now(),
    });

    return {
      connectionUri,
      databaseName: dbName,
      username,
      password,
    };
  }

  // Safely deprovisions tenant database and removes tenant record
  async deprovisionPostgresTenant(projectId: string): Promise<void> {
    const cleanId = projectId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const dbName = `db_${cleanId}`;
    const username = `usr_${cleanId}`;

    const isRunning = await dockerService.isContainerRunning(this.sharedPostgresName);
    if (isRunning) {
      const teardownCommands = `
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}';
        DROP DATABASE IF EXISTS ${dbName};
        DROP USER IF EXISTS ${username};
      `;

      try {
        await dockerService.execCommand(this.sharedPostgresName, [
          'psql',
          '-U',
          'deploymind_admin',
          '-d',
          'postgres',
          '-c',
          teardownCommands,
        ]);
      } catch (err) {
        console.warn('[ResourceManager] Deprovisioning tenant in shared Postgres warning:', err);
      }
    }

    await db
      .delete(schema.resourceTenants)
      .where(eq(schema.resourceTenants.projectId, projectId));
  }

  // Provisions Redis connection and tracks tenant for project
  async provisionRedisTenant(projectId: string): Promise<TenantCredentials> {
    const resourceId = await this.ensureSharedRedis();
    const cleanId = projectId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const username = `usr_${cleanId}`;
    const password = crypto.randomBytes(16).toString('hex');
    const keyPrefix = `proj_${cleanId}:`;

    const isRunning = await dockerService.isContainerRunning(this.sharedRedisName);
    if (isRunning) {
      const redisAdminPass = this.getRedisAdminPassword();
      try {
        const execRes = await dockerService.execCommand(this.sharedRedisName, [
          'redis-cli',
          '-a',
          redisAdminPass,
          'ACL',
          'SETUSER',
          username,
          'on',
          `>${password}`,
          `~${keyPrefix}*`,
          `~${cleanId}:*`,
          '+@all',
          '-@dangerous',
        ]);
        if (execRes && execRes.exitCode !== 0) {
          throw new Error(`redis-cli exited with code ${execRes.exitCode}: ${execRes.output}`);
        }
      } catch (err: any) {
        console.error('[ResourceManager] Error provisioning tenant in shared Redis:', err);
        throw new Error(`Failed to configure isolated Redis ACL for tenant: ${err?.message || err}`);
      }
    } else if (process.env.NODE_ENV !== 'test') {
      const isDockerReady = await dockerService.isAvailable();
      if (isDockerReady) {
        throw new Error(`Shared Redis container is not running. Cannot provision tenant.`);
      }
    }

    const connectionUri = `redis://${username}:${password}@${this.sharedRedisName}:6379`;
    const tenantId = `ten_rd_${projectId.slice(0, 16)}`;

    await db
      .delete(schema.resourceTenants)
      .where(
        and(
          eq(schema.resourceTenants.projectId, projectId),
          eq(schema.resourceTenants.resourceId, resourceId)
        )
      );

    await db.insert(schema.resourceTenants).values({
      id: tenantId,
      resourceId,
      projectId,
      databaseName: `proj_${cleanId}`,
      username,
      encryptedCredentials: JSON.stringify({ connectionUri, keyPrefix }),
      createdAt: Date.now(),
    });

    return {
      connectionUri,
      username,
      password,
      keyPrefix,
    };
  }

  // Safely deprovisions Redis tenant
  async deprovisionRedisTenant(projectId: string): Promise<void> {
    const cleanId = projectId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const username = `usr_${cleanId}`;

    const isRunning = await dockerService.isContainerRunning(this.sharedRedisName);
    if (isRunning) {
      const redisAdminPass = this.getRedisAdminPassword();
      try {
        await dockerService.execCommand(this.sharedRedisName, [
          'redis-cli',
          '-a',
          redisAdminPass,
          'ACL',
          'DELUSER',
          username,
        ]);
      } catch {
        // Non-fatal
      }
    }

    await db
      .delete(schema.resourceTenants)
      .where(eq(schema.resourceTenants.projectId, projectId));
  }

  // Count active tenants depending on a shared resource
  async getTenantCount(resourceId: string): Promise<number> {
    const rows = await db
      .select()
      .from(schema.resourceTenants)
      .where(eq(schema.resourceTenants.resourceId, resourceId));
    return rows.length;
  }

  // Deletion guard for shared PostgreSQL: blocks deletion if applications depend on it
  async deleteSharedPostgres(force = false): Promise<void> {
    const tenantCount = await this.getTenantCount('res_shared_postgres');
    if (tenantCount > 0 && !force) {
      throw new Error(
        `Safety Violation: Cannot delete shared PostgreSQL cluster while ${tenantCount} project tenant(s) are actively bound.`
      );
    }
    await dockerService.stopAndRemove(this.sharedPostgresName);
    await db
      .update(schema.sharedResources)
      .set({ isActive: false })
      .where(eq(schema.sharedResources.id, 'res_shared_postgres'));
  }
}

export const resourceManager = new ResourceManager();
