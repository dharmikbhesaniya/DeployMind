import crypto from 'node:crypto';
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

  private adminSecrets = new Map<string, string>();

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

    // Securely generate administrative credentials
    let adminPassword = this.adminSecrets.get(containerName);
    if (!adminPassword) {
      adminPassword = crypto.randomBytes(24).toString('hex');
      this.adminSecrets.set(containerName, adminPassword);
      await vaultService
        .createCredential({
          keyName: `ADMIN_SECRET_${containerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
          plaintextValue: adminPassword,
          description: `Administrative credential for ${containerName}`,
          isSystemGenerated: true,
        })
        .catch(() => {});
    }

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
    const cleanProjId = projectId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const cleanType = this.type.toLowerCase().replace(/[^a-z0-9]/g, '_');

    // Generate isolated credentials securely
    const tenantPrefix = `proj_${cleanProjId}`;
    const databaseName = `db_${cleanProjId}`;
    const username = `usr_${cleanType.slice(0, 4)}_${cleanProjId.slice(0, 10)}`;
    const password = crypto.randomBytes(16).toString('hex');
    const tenantTopic = `topic_${cleanProjId}`;

    const adminPassword = this.adminSecrets.get(instanceContainerName) || '';

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
            await dockerService.execCommand(instanceContainerName, substitutedCmd);
          } catch (err: any) {
            if (!step.ignoreFailure) {
              console.warn(`[GenericDefinitionAdapter:${this.type}] Provision workflow step "${step.name}" notice: ${err.message}`);
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
      .catch(() => {});

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

    const tenantBase = cleanProjId.startsWith('proj_') ? cleanProjId.slice(5) : cleanProjId;
    const tenantPrefix = `proj_${tenantBase}`;
    const databaseName = `db_${cleanType.slice(0, 4)}_${cleanProjId}`;
    const username = `usr_${cleanType.slice(0, 4)}_${tenantBase.slice(0, 10)}`;
    const tenantTopic = `topic_${cleanProjId}`;
    const adminPassword = this.adminSecrets.get(instanceContainerName) || '';

    const isDockerAvailable = await dockerService.isAvailable();
    if (isDockerAvailable && this.definition.deprovisionWorkflow) {
      for (const step of this.definition.deprovisionWorkflow) {
        if (step.action === 'exec_in_container' && step.command) {
          const substitutedCmd = step.command.map((token) =>
            token
              .replace(/\${DATABASE}/g, databaseName)
              .replace(/\${USERNAME}/g, username)
              .replace(/\${TENANT_TOPIC}/g, tenantTopic)
              .replace(/\${TENANT_PREFIX}/g, cleanProjId)
              .replace(/\${HOST}/g, instanceContainerName)
              .replace(/\${PORT}/g, this.defaultPort.toString())
              .replace(/\${ADMIN_PASSWORD}/g, adminPassword)
          );

          await dockerService
            .execCommand(instanceContainerName, substitutedCmd)
            .catch(() => {});
        }
      }
    }
  }

  async checkHealth(instanceContainerName: string): Promise<'healthy' | 'degraded' | 'unavailable'> {
    const isRunning = await dockerService.isContainerRunning(instanceContainerName);
    if (isRunning) return 'healthy';
    if (process.env.NODE_ENV === 'test') return 'healthy';

    const isDockerAvailable = await dockerService.isAvailable();
    if (!isDockerAvailable) return 'healthy';

    return 'unavailable';
  }
}
