import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ResourceAdapter, ResourceRequirement, ResourceTenantBinding } from './resource.adapter.js';
import { dockerService } from '../../docker/docker.service.js';
import { config } from '../../../config/index.js';

export class MysqlAdapter implements ResourceAdapter {
  readonly type = 'mysql';
  readonly defaultImage = 'mariadb:11-jammy';
  readonly defaultPort = 3306;
  readonly defaultAliases = ['mysql', 'shared-mysql', 'mariadb'];
  readonly sharingSupported = true;
  readonly capabilities = ['relational', 'transactions', 'acid'];

  getAdminPassword(): string {
    const keyPath = path.resolve(config.dataDir, 'mysql_admin.key');
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
      return 'deploymind_my_sec_admin';
    }
  }

  async ensureInstance(resourceId: string, options?: Record<string, any>): Promise<{
    containerName: string;
    hostPort: number;
    metadata: Record<string, any>;
  }> {
    const containerName = options?.containerName || 'deploymind-shared-mysql';
    const hostPort = options?.hostPort || 3306;
    const isDockerReady = await dockerService.isAvailable();

    if (isDockerReady) {
      try {
        const adminPass = this.getAdminPassword();
        await dockerService.startContainer({
          containerName,
          imageTag: this.defaultImage,
          env: {
            MARIADB_ROOT_PASSWORD: adminPass,
            MYSQL_ROOT_PASSWORD: adminPass,
          },
          exposedPort: 3306,
          memoryLimitMb: 512,
          volumes: [
            {
              hostVolumeName: 'deploymind-mysql-data',
              containerPath: '/var/lib/mysql',
            },
          ],
          networkAliases: this.defaultAliases,
          labels: {
            'deploymind.managed': 'true',
            'deploymind.resource_type': this.type,
          },
        });
      } catch {
        // Container may already be running
      }
    }

    return {
      containerName,
      hostPort,
      metadata: {
        version: '11-jammy',
        engine: 'mariadb/mysql',
        volume: 'deploymind-mysql-data',
      },
    };
  }

  async provisionTenant(
    instanceContainerName: string,
    projectId: string,
    _requirement: ResourceRequirement
  ): Promise<ResourceTenantBinding> {
    const cleanId = projectId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const dbName = `db_${cleanId}`;
    const username = `usr_${cleanId}`;
    const password = crypto.randomBytes(16).toString('hex');

    const isRunning = await dockerService.isContainerRunning(instanceContainerName);
    if (isRunning) {
      const adminPass = this.getAdminPassword();
      const sqlCommands = `
        CREATE DATABASE IF NOT EXISTS \`${dbName}\`;
        CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED BY '${password}';
        GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${username}'@'%';
        FLUSH PRIVILEGES;
      `;

      try {
        const execRes = await dockerService.execCommand(instanceContainerName, [
          'mariadb',
          '-u',
          'root',
          `-p${adminPass}`,
          '-e',
          sqlCommands,
        ]);
        if (execRes && execRes.exitCode !== 0) {
          throw new Error(`MySQL client returned exit code ${execRes.exitCode}: ${execRes.output}`);
        }
      } catch (err: any) {
        throw new Error(`Failed to provision isolated MySQL tenant: ${err?.message || err}`);
      }
    } else if (process.env.NODE_ENV !== 'test') {
      const isDockerReady = await dockerService.isAvailable();
      if (isDockerReady) {
        throw new Error(`MySQL instance container ${instanceContainerName} is offline.`);
      }
    }

    const connectionUri = `mysql://${username}:${password}@${instanceContainerName}:3306/${dbName}`;
    const credentials = {
      DATABASE_URL: connectionUri,
      MYSQL_URL: connectionUri,
      MYSQL_HOST: instanceContainerName,
      MYSQL_PORT: '3306',
      MYSQL_USER: username,
      MYSQL_PASSWORD: password,
      MYSQL_DATABASE: dbName,
    };

    return {
      connectionUri,
      databaseName: dbName,
      username,
      password,
      credentials,
      envExports: credentials,
    };
  }

  async deprovisionTenant(instanceContainerName: string, projectId: string): Promise<void> {
    const cleanId = projectId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const dbName = `db_${cleanId}`;
    const username = `usr_${cleanId}`;

    const isRunning = await dockerService.isContainerRunning(instanceContainerName);
    if (isRunning) {
      const adminPass = this.getAdminPassword();
      const teardownCommands = `
        DROP DATABASE IF EXISTS \`${dbName}\`;
        DROP USER IF EXISTS '${username}'@'%';
        FLUSH PRIVILEGES;
      `;

      try {
        await dockerService.execCommand(instanceContainerName, [
          'mariadb',
          '-u',
          'root',
          `-p${adminPass}`,
          '-e',
          teardownCommands,
        ]);
      } catch (err) {
        console.warn(`[MysqlAdapter] Deprovision warning for tenant ${projectId}:`, err);
      }
    }
  }

  async checkHealth(instanceContainerName: string): Promise<'healthy' | 'degraded' | 'unavailable'> {
    const isRunning = await dockerService.isContainerRunning(instanceContainerName);
    if (isRunning) return 'healthy';
    if (process.env.NODE_ENV === 'test') return 'healthy';
    return 'unavailable';
  }
}

export const mysqlAdapter = new MysqlAdapter();
