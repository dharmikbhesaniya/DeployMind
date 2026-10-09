import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { dockerService } from '../docker/docker.service.js';
import { db, schema } from '../../db/index.js';

export interface TenantCredentials {
  connectionUri: string;
  databaseName?: string;
  username?: string;
  password?: string;
}

export class ResourceManager {
  readonly sharedPostgresName = 'deploymind-shared-postgres';
  readonly sharedRedisName = 'deploymind-shared-redis';

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
      await dockerService.startContainer({
        containerName: this.sharedPostgresName,
        imageTag: 'postgres:16-alpine',
        env: {
          POSTGRES_USER: 'deploymind_admin',
          POSTGRES_PASSWORD: 'deploymind_secure_pass',
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
      await dockerService.startContainer({
        containerName: this.sharedRedisName,
        imageTag: 'redis:7-alpine',
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
    `;

    try {
      await dockerService.execCommand(this.sharedPostgresName, [
        'psql',
        '-U',
        'deploymind_admin',
        '-d',
        'postgres',
        '-c',
        sqlCommands,
      ]);
    } catch (err) {
      console.warn('[ResourceManager] Provisioning tenant in shared Postgres warning:', err);
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

    // Create Redis 7 ACL user with key pattern constraint
    try {
      await dockerService.execCommand(this.sharedRedisName, [
        'redis-cli',
        'ACL',
        'SETUSER',
        username,
        'on',
        `>${password}`,
        `~proj_${cleanId}:*`,
        '+@all',
        '-@dangerous',
      ]);
    } catch {
      // Non-fatal if Redis ACL is disabled
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
      encryptedCredentials: JSON.stringify({ connectionUri }),
      createdAt: Date.now(),
    });

    return {
      connectionUri,
      username,
      password,
    };
  }

  // Safely deprovisions Redis tenant
  async deprovisionRedisTenant(projectId: string): Promise<void> {
    const cleanId = projectId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const username = `usr_${cleanId}`;

    try {
      await dockerService.execCommand(this.sharedRedisName, [
        'redis-cli',
        'ACL',
        'DELUSER',
        username,
      ]);
    } catch {
      // Non-fatal
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
