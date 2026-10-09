/**
 * Pluggable Resource Adapter Specifications
 *
 * Defines the generic contract for backing infrastructure services (PostgreSQL, Redis, MySQL,
 * MongoDB, RabbitMQ, MinIO, etc.) managed and shared on the DeployMind container network.
 */

export type IsolationLevel = 'standard' | 'strong' | 'dedicated';

export interface ResourceRequirement {
  type: string; // e.g. "postgres", "redis", "mysql", "mongodb", "rabbitmq", "minio"
  versionRange?: string;
  capabilities?: string[];
  configuration?: Record<string, unknown>;
  persistenceRequired?: boolean;
  isolationLevel?: IsolationLevel;
}

export interface ResourceCandidate {
  id: string;
  type: string;
  version: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  capacity: {
    availableMemoryMb?: number;
    availableStorageMb?: number;
    availableConnections?: number;
    activeTenants?: number;
  };
  capabilities: string[];
  sharingSupported: boolean;
}

export interface ResourceTenantBinding {
  connectionUri: string;
  credentials: Record<string, string>;
  envExports: Record<string, string>;
  databaseName?: string;
  username?: string;
  password?: string;
  keyPrefix?: string;
}

export type ResourceDecision =
  | { action: 'reuse'; resourceId: string; binding?: ResourceTenantBinding }
  | { action: 'provision'; requirement: ResourceRequirement }
  | { action: 'ask_user'; reason: string }
  | { action: 'reject'; reason: string };

export interface ResourceAdapter {
  readonly type: string;
  readonly defaultImage: string;
  readonly defaultPort: number;
  readonly defaultAliases: string[];
  readonly sharingSupported: boolean;
  readonly capabilities: string[];

  /**
   * Ensures the backing shared container instance is running on deploymind-net.
   */
  ensureInstance(resourceId: string, options?: Record<string, any>): Promise<{
    containerName: string;
    hostPort: number;
    metadata: Record<string, any>;
  }>;

  /**
   * Provisions an isolated tenant database/user/vhost/bucket on the shared instance.
   */
  provisionTenant(
    instanceContainerName: string,
    projectId: string,
    requirement: ResourceRequirement
  ): Promise<ResourceTenantBinding>;

  /**
   * Deprovisions an isolated tenant from the shared instance without touching other tenants.
   */
  deprovisionTenant(
    instanceContainerName: string,
    projectId: string
  ): Promise<void>;

  /**
   * Verifies health and availability of the shared instance.
   */
  checkHealth(instanceContainerName: string): Promise<'healthy' | 'degraded' | 'unavailable'>;
}
