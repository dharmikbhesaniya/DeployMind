import crypto from 'node:crypto';
import { dockerService } from '../docker/docker.service.js';

export interface TenantCredentials {
  connectionUri: string;
  databaseName?: string;
  username?: string;
  password?: string;
}

export class ResourceManager {
  readonly sharedPostgresName = 'deployagent-shared-postgres';
  readonly sharedRedisName = 'deployagent-shared-redis';

  // Ensures shared PostgreSQL cluster is available on the network
  async ensureSharedPostgres(): Promise<void> {
    const isDockerReady = await dockerService.isAvailable();
    if (!isDockerReady) return;

    try {
      await dockerService.startContainer({
        containerName: this.sharedPostgresName,
        imageTag: 'postgres:16-alpine',
        env: {
          POSTGRES_USER: 'deployagent_admin',
          POSTGRES_PASSWORD: 'deployagent_secure_pass',
          POSTGRES_DB: 'postgres',
        },
        exposedPort: 5432,
        memoryLimitMb: 512,
      });
    } catch {
      // Container may already be running
    }
  }

  // Ensures shared Redis cluster is available on the network
  async ensureSharedRedis(): Promise<void> {
    const isDockerReady = await dockerService.isAvailable();
    if (!isDockerReady) return;

    try {
      await dockerService.startContainer({
        containerName: this.sharedRedisName,
        imageTag: 'redis:7-alpine',
        env: {},
        exposedPort: 6379,
        memoryLimitMb: 256,
      });
    } catch {
      // Container may already be running
    }
  }

  // Provisions an isolated tenant database & user in shared PostgreSQL
  async provisionPostgresTenant(projectId: string): Promise<TenantCredentials> {
    await this.ensureSharedPostgres();

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
        'deployagent_admin',
        '-d',
        'postgres',
        '-c',
        sqlCommands,
      ]);
    } catch (err) {
      console.warn('[ResourceManager] Provisioning tenant in shared Postgres warning:', err);
    }

    const connectionUri = `postgresql://${username}:${password}@${this.sharedPostgresName}:5432/${dbName}`;

    return {
      connectionUri,
      databaseName: dbName,
      username,
      password,
    };
  }

  // Provisions Redis connection for project
  async provisionRedisTenant(_projectId: string): Promise<TenantCredentials> {
    await this.ensureSharedRedis();
    return {
      connectionUri: `redis://${this.sharedRedisName}:6379`,
    };
  }
}

export const resourceManager = new ResourceManager();
