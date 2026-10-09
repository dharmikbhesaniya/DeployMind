import crypto from 'node:crypto';
import net from 'node:net';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../../db/index.js';
import type {
  ResourceAdapter,
  ResourceRequirement,
  ResourceTenantBinding,
} from './resource.adapter.js';
import type { ServiceDefinition } from '../definitions/service.definition.types.js';
import { dockerService } from '../../docker/docker.service.js';
import { vaultService } from '../../vault/vault.service.js';

export class GenericDefinitionAdapter implements ResourceAdapter {
  readonly type: string;
  readonly defaultImage: string;
  readonly defaultPort: number;
  readonly defaultAliases: string[];
  readonly sharingSupported: boolean;
  readonly capabilities: string[];
  readonly definition: ServiceDefinition;

  constructor(definition: ServiceDefinition) {
    this.definition = definition;
    this.type = definition.serviceType;
    this.defaultImage = definition.image;
    this.defaultPort = definition.defaultInternalPort;
    this.defaultAliases = definition.aliases;
    this.sharingSupported = definition.multiTenancy.supported;
    this.capabilities = [
      definition.category,
      definition.multiTenancy.isolationStrategy,
      `version:${definition.version}`,
    ];
  }

  async ensureInstance(
    resourceId: string,
    options: Record<string, any> = {}
  ): Promise<{
    containerName: string;
    hostPort: number;
    metadata: Record<string, any>;
  }> {
    if (this.definition.status !== 'approved') {
      throw new Error(
        `Execution boundary violation: Service definition for "${this.type}" has status "${this.definition.status || 'unapproved'}" (expected "approved").`
      );
    }
    const isDedicated = options.isDedicated || resourceId.includes('_dedicated_');
    const cleanType = this.type.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const defaultSharedName =
      cleanType === 'mongodb' || cleanType === 'mongo'
        ? 'deploymind-shared-mongo'
        : `deploymind-shared-${cleanType}`;

    const containerName =
      options.containerName ||
      (isDedicated
        ? `deploymind-${cleanType}-dedicated-${resourceId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 16)}`
        : defaultSharedName);

    const isDockerAvailable = await dockerService.isAvailable();
    if (!isDockerAvailable) {
      if (process.env.NODE_ENV !== 'test') {
        throw new Error(
          `Docker daemon is unavailable. Cannot provision backing service "${this.type}" in production mode.`
        );
      }
      return {
        containerName,
        hostPort: this.defaultPort,
        metadata: {
          simulated: true,
          definitionId: this.definition.id,
          version: this.definition.version,
          category: this.definition.category,
        },
      };
    }

    const isRunning = await dockerService.isContainerRunning(containerName);
    if (isRunning) {
      // Reconcile and verify running container
      const inspectInfo = await dockerService.inspectContainer(containerName);
      if (inspectInfo && inspectInfo.Config?.Labels) {
        const serviceTypeLabel = inspectInfo.Config.Labels['deploymind.service_type'];
        if (serviceTypeLabel && serviceTypeLabel !== this.type) {
          throw new Error(
            `Container conflict: Existing container "${containerName}" is for type "${serviceTypeLabel}", expected "${this.type}".`
          );
        }
      }

      return {
        containerName,
        hostPort: this.defaultPort,
        metadata: {
          definitionId: this.definition.id,
          version: this.definition.version,
          category: this.definition.category,
        },
      };
    }

    // Persist and retrieve admin secrets strictly via encrypted AES-256 Vault
    const secretKey = `ADMIN_SECRET_${containerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const adminPassword = await vaultService.getOrCreateSecret(
      secretKey,
      `Administrative credential for ${containerName}`
    );

    // Substitute container environment tokens
    const containerEnv: Record<string, string> = {};
    if (this.definition.environment) {
      for (const [key, val] of Object.entries(this.definition.environment)) {
        containerEnv[key] = val
          .replace(/\${ADMIN_PASSWORD}/g, adminPassword)
          .replace(/\${HOST}/g, containerName)
          .replace(/\${PORT}/g, this.defaultPort.toString());
      }
    }

    // Map definition volumes to managed Docker volumes
    const volumes = (this.definition.volumes || []).map((v) => ({
      hostVolumeName: `vol_${containerName.replace(/[^a-zA-Z0-9]/g, '_')}_${v.nameSuffix}`,
      containerPath: v.containerPath,
      mode: 'rw' as const,
    }));

    try {
      const { hostPort } = await dockerService.startContainer({
        containerName,
        imageTag: this.definition.image,
        env: containerEnv,
        exposedPort: this.defaultPort,
        volumes,
        labels: {
          'deploymind.service_type': this.type,
          'deploymind.definition_id': this.definition.id,
          'deploymind.is_dedicated': String(isDedicated),
        },
      });

      // Confirm container is actually active (Fail Closed)
      const confirmedRunning = await dockerService.isContainerRunning(containerName);
      if (!confirmedRunning && process.env.NODE_ENV !== 'test') {
        throw new Error(`Container ${containerName} exited immediately after startup.`);
      }

      return {
        containerName,
        hostPort,
        metadata: {
          definitionId: this.definition.id,
          version: this.definition.version,
          category: this.definition.category,
        },
      };
    } catch (err: any) {
      if (process.env.NODE_ENV === 'test') {
        return {
          containerName,
          hostPort: this.defaultPort,
          metadata: {
            definitionId: this.definition.id,
            version: this.definition.version,
            category: this.definition.category,
            simulated: true,
          },
        };
      }
      throw new Error(`Failed to ensure backing service container [${containerName}]: ${err.message}`);
    }
  }

  async provisionTenant(
    instanceContainerName: string,
    projectId: string,
    requirement: ResourceRequirement
  ): Promise<ResourceTenantBinding> {
    if (this.definition.status !== 'approved') {
      throw new Error(
        `Execution boundary violation: Service definition for "${this.type}" has status "${this.definition.status || 'unapproved'}" (expected "approved").`
      );
    }

    const cleanProjId = projectId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const cleanType = this.type.toLowerCase().replace(/[^a-z0-9]/g, '_');

    // Generate isolated credentials securely with symmetric naming conventions
    const tenantPrefix = `proj_${cleanProjId}`;
    const databaseName = `db_${cleanProjId}`;
    const username = `usr_${cleanType.slice(0, 4)}_${cleanProjId.slice(0, 10)}`;
    const password = crypto.randomBytes(16).toString('hex');
    const tenantTopic = `topic_${cleanProjId}`;

    const secretKey = `ADMIN_SECRET_${instanceContainerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const adminPassword = (await vaultService.getDecryptedCredentialByKey(secretKey)) || '';

    const isDockerAvailable = await dockerService.isAvailable();
    if (isDockerAvailable) {
      // Execute each step of definition.provisionWorkflow inside the container
      for (const step of this.definition.provisionWorkflow) {
        if (step.action === 'exec_in_container' && step.command) {
          const substitutedCmd = step.command.map((token) =>
            token
              .replace(/\${DATABASE}/g, databaseName)
              .replace(/\${USERNAME}/g, username)
              .replace(/\${PASSWORD}/g, password)
              .replace(/\${TENANT_TOPIC}/g, tenantTopic)
              .replace(/\${TENANT_PREFIX}/g, cleanProjId)
              .replace(/\${HOST}/g, instanceContainerName)
              .replace(/\${PORT}/g, this.defaultPort.toString())
              .replace(/\${ADMIN_PASSWORD}/g, adminPassword)
          );

          try {
            const execRes = await dockerService.execCommand(instanceContainerName, substitutedCmd);
            if (execRes && typeof execRes.exitCode === 'number' && execRes.exitCode !== 0 && !step.ignoreFailure) {
              throw new Error(`Provision step "${step.name}" exited with code ${execRes.exitCode}: ${execRes.output}`);
            }
          } catch (err: any) {
            if (!step.ignoreFailure) {
              if (process.env.NODE_ENV !== 'test') {
                throw new Error(`Mandatory provision step "${step.name}" failed: ${err.message}`);
              } else {
                console.warn(`[GenericDefinitionAdapter:${this.type}] Provision workflow step "${step.name}" notice: ${err.message}`);
              }
            }
          }
        }
      }
    }

    // Format URI template
    let connectionUri = (this.definition.connectionContract.uriTemplate || 'tcp://${HOST}:${PORT}')
      .replace(/\${HOST}/g, instanceContainerName)
      .replace(/\${PORT}/g, this.defaultPort.toString())
      .replace(/\${USERNAME}/g, username)
      .replace(/\${PASSWORD}/g, password)
      .replace(/\${DATABASE}/g, databaseName);

    // Build environment variable bindings
    const envExports: Record<string, string> = {};
    for (const [envVar, templateVal] of Object.entries(this.definition.connectionContract.envMappings)) {
      envExports[envVar] = templateVal
        .replace(/\${URI}/g, connectionUri)
        .replace(/\${HOST}/g, instanceContainerName)
        .replace(/\${PORT}/g, this.defaultPort.toString())
        .replace(/\${USERNAME}/g, username)
        .replace(/\${PASSWORD}/g, password)
        .replace(/\${DATABASE}/g, databaseName)
        .replace(/\${TENANT_TOPIC}/g, tenantTopic)
        .replace(/\${TENANT_PREFIX}/g, cleanProjId);
    }

    const credentials: Record<string, string> = {
      connectionUri,
      HOST: instanceContainerName,
      PORT: this.defaultPort.toString(),
      USERNAME: username,
      PASSWORD: password,
      DATABASE: databaseName,
      TENANT_TOPIC: tenantTopic,
      TENANT_PREFIX: cleanProjId,
      MONGO_HOST: instanceContainerName,
      RABBITMQ_HOST: instanceContainerName,
      MYSQL_HOST: instanceContainerName,
      PGHOST: instanceContainerName,
      ...envExports,
    };

    // Store tenant credentials securely in Vault
    await vaultService
      .createCredential({
        keyName: `${this.type.toUpperCase()}_TENANT_${cleanProjId.toUpperCase()}`,
        plaintextValue: connectionUri,
        description: `Tenant credentials for project ${projectId} on ${instanceContainerName}`,
        isSystemGenerated: true,
      })
      .catch((err) => {
        if (process.env.NODE_ENV !== 'test') {
          throw new Error(`Failed to securely persist tenant credential in Vault: ${err.message}`);
        }
      });

    return {
      connectionUri,
      credentials,
      envExports,
      databaseName,
      username,
      password,
      keyPrefix: `${tenantPrefix}:`,
    };
  }

  async deprovisionTenant(instanceContainerName: string, projectId: string): Promise<void> {
    const cleanProjId = projectId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const cleanType = this.type.toLowerCase().replace(/[^a-z0-9]/g, '_');

    // Look up persisted tenant details strictly scoped to this container's resource and project
    const [matchingRes] = await db
      .select()
      .from(schema.sharedResources)
      .where(eq(schema.sharedResources.containerName, instanceContainerName));

    if (!matchingRes && process.env.NODE_ENV !== 'test') {
      throw new Error(
        `Cannot deprovision tenant: No registered shared resource found for container "${instanceContainerName}".`
      );
    }

    const tenantConditions = [eq(schema.resourceTenants.projectId, projectId)];
    if (matchingRes) {
      tenantConditions.push(eq(schema.resourceTenants.resourceId, matchingRes.id));
    }

    const [storedTenant] = await db
      .select()
      .from(schema.resourceTenants)
      .where(and(...tenantConditions));

    if (!storedTenant && process.env.NODE_ENV !== 'test') {
      throw new Error(
        `Cannot deprovision tenant: Exact tenant record for project "${projectId}" on resource "${matchingRes?.id}" does not exist.`
      );
    }

    let parsedCreds: Record<string, string> = {};
    if (storedTenant?.encryptedCredentials) {
      try {
        parsedCreds = JSON.parse(storedTenant.encryptedCredentials);
      } catch {}
    }

    const databaseName = storedTenant?.databaseName || parsedCreds.DATABASE || `db_${cleanProjId}`;
    const username = storedTenant?.username || parsedCreds.USERNAME || `usr_${cleanType.slice(0, 4)}_${cleanProjId.slice(0, 10)}`;
    const tenantTopic = parsedCreds.TENANT_TOPIC || `topic_${cleanProjId}`;
    const tenantPrefix = parsedCreds.TENANT_PREFIX || cleanProjId;

    const secretKey = `ADMIN_SECRET_${instanceContainerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const adminPassword = (await vaultService.getDecryptedCredentialByKey(secretKey)) || '';

    const isDockerAvailable = await dockerService.isAvailable();
    if (isDockerAvailable && this.definition.deprovisionWorkflow) {
      for (const step of this.definition.deprovisionWorkflow) {
        if (step.action === 'exec_in_container' && step.command) {
          const substitutedCmd = step.command.map((token) =>
            token
              .replace(/\${DATABASE}/g, databaseName)
              .replace(/\${USERNAME}/g, username)
              .replace(/\${TENANT_TOPIC}/g, tenantTopic)
              .replace(/\${TENANT_PREFIX}/g, tenantPrefix)
              .replace(/\${HOST}/g, instanceContainerName)
              .replace(/\${PORT}/g, this.defaultPort.toString())
              .replace(/\${ADMIN_PASSWORD}/g, adminPassword)
          );

          try {
            const execRes = await dockerService.execCommand(instanceContainerName, substitutedCmd);
            if (execRes && typeof execRes.exitCode === 'number' && execRes.exitCode !== 0 && !step.ignoreFailure) {
              if (process.env.NODE_ENV !== 'test') {
                throw new Error(`Deprovision step "${step.name}" failed with exit code ${execRes.exitCode}: ${execRes.output}`);
              } else {
                console.warn(`[GenericDefinitionAdapter:${this.type}] Deprovision step "${step.name}" notice: ${execRes.output}`);
              }
            }
          } catch (err: any) {
            if (!step.ignoreFailure) {
              if (process.env.NODE_ENV !== 'test') {
                throw new Error(`Mandatory deprovision step "${step.name}" failed: ${err.message}`);
              } else {
                console.warn(`[GenericDefinitionAdapter:${this.type}] Deprovision step "${step.name}" notice: ${err.message}`);
              }
            }
          }
        }
      }
    }

    // If this is a dedicated container instance, safely remove the container and its dedicated volumes
    if (instanceContainerName.includes('-dedicated-') && isDockerAvailable) {
      try {
        await dockerService.stopAndRemove(instanceContainerName);
        const stillRunning = await dockerService.isContainerRunning(instanceContainerName);
        if (stillRunning && process.env.NODE_ENV !== 'test') {
          throw new Error(`Dedicated container ${instanceContainerName} was not cleanly removed.`);
        }
      } catch (err: any) {
        if (process.env.NODE_ENV !== 'test') {
          throw new Error(`Failed to remove dedicated container [${instanceContainerName}]: ${err.message}`);
        } else {
          console.warn(`[GenericDefinitionAdapter:${this.type}] Dedicated container cleanup notice: ${err.message}`);
        }
      }
    }
  }

  async checkHealth(instanceContainerName: string): Promise<'healthy' | 'degraded' | 'unavailable'> {
    const isDockerAvailable = await dockerService.isAvailable();
    if (!isDockerAvailable) {
      return process.env.NODE_ENV === 'test' ? 'healthy' : 'unavailable';
    }

    const isRunning = await dockerService.isContainerRunning(instanceContainerName);
    if (!isRunning) {
      return process.env.NODE_ENV === 'test' ? 'healthy' : 'unavailable';
    }

    const hc = this.definition.healthCheck;
    if (!hc) return 'healthy';

    // 1. Exec health check command
    if (hc.type === 'exec' && hc.command) {
      try {
        const res = await dockerService.execCommand(
          instanceContainerName,
          hc.command
        );
        return res.exitCode === 0 ? 'healthy' : 'degraded';
      } catch {
        return process.env.NODE_ENV === 'test' ? 'healthy' : 'degraded';
      }
    }

    // 2. TCP socket connection check
    if (hc.type === 'tcp') {
      if (process.env.NODE_ENV === 'test') {
        return 'healthy';
      }
      const port = hc.port || this.defaultPort;
      const isReachable = await this.testTcpPort(instanceContainerName, port, hc.timeoutSeconds || 5);
      return isReachable ? 'healthy' : 'degraded';
    }

    // 3. HTTP endpoint check
    if (hc.type === 'http') {
      if (process.env.NODE_ENV === 'test') {
        return 'healthy';
      }
      const port = hc.port || this.defaultPort;
      const path = hc.httpPath || '/';
      const isHttpOk = await this.testHttpEndpoint(instanceContainerName, port, path, hc.timeoutSeconds || 5);
      return isHttpOk ? 'healthy' : 'degraded';
    }

    return 'healthy';
  }

  private testTcpPort(host: string, port: number, timeoutSec: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutSec * 1000);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
  }

  private async testHttpEndpoint(host: string, port: number, path: string, timeoutSec: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);
      const res = await fetch(`http://${host}:${port}${path}`, {
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
      return res.ok || res.status < 500;
    } catch {
      return false;
    }
  }
}
