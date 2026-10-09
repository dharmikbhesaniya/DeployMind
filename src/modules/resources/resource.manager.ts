import { eq } from 'drizzle-orm';
import { dockerService } from '../docker/docker.service.js';
import { db, schema } from '../../db/index.js';
import { resourceRegistry } from './resource.registry.js';
import { resourcePlanner } from './resource.planner.js';
import type {
  ResourceRequirement,
  ResourceTenantBinding,
} from './adapters/resource.adapter.js';
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

  // Backwards-compatible secret getters
  getPostgresAdminPassword(): string {
    return 'deploymind_admin_sec_pg';
  }

  getRedisAdminPassword(): string {
    return 'deploymind_admin_sec_redis';
  }

  // Ensures any backing service cluster is online and tracked in DB
  async ensureResource(type: string): Promise<string> {
    const normalized = resourceRegistry.normalizeType(type);
    let adapter = resourceRegistry.getAdapter(normalized);
    if (!adapter) {
      adapter = await resourceRegistry.getOrResolveAdapter(normalized);
    }

    const resourceId = `res_shared_${normalized}`;
    const [existing] = await db
      .select()
      .from(schema.sharedResources)
      .where(eq(schema.sharedResources.id, resourceId));

    const instanceInfo = await adapter.ensureInstance(resourceId);

    if (!existing) {
      await db.insert(schema.sharedResources).values({
        id: resourceId,
        resourceType: normalized,
        containerName: instanceInfo.containerName,
        hostPort: instanceInfo.hostPort,
        isActive: true,
        metadata: JSON.stringify(instanceInfo.metadata),
      });
    }

    return resourceId;
  }

  async ensureSharedPostgres(): Promise<string> {
    return this.ensureResource('postgres');
  }

  async ensureSharedRedis(): Promise<string> {
    return this.ensureResource('redis');
  }

  /**
   * Generic dynamic tenant provisioning:
   * Uses ResourcePlanner policy engine to evaluate compatibility and reuse existing container,
   * or provision baseline instance dynamically.
   */
  async provisionTenant(
    projectId: string,
    requirement: ResourceRequirement
  ): Promise<ResourceTenantBinding> {
    const plan = await resourcePlanner.evaluateRequirement(requirement);
    const execution = await resourcePlanner.executeDecision({
      decision: plan.decision,
      projectId,
      requirement,
    });
    return execution.binding;
  }

  // Backwards-compatible PostgreSQL tenant provisioning
  async provisionPostgresTenant(projectId: string): Promise<TenantCredentials> {
    const binding = await this.provisionTenant(projectId, {
      type: 'postgres',
      isolationLevel: 'standard',
    });
    return {
      connectionUri: binding.connectionUri,
      databaseName: binding.databaseName,
      username: binding.username,
      password: binding.password,
    };
  }

  // Backwards-compatible Redis tenant provisioning
  async provisionRedisTenant(projectId: string): Promise<TenantCredentials> {
    const binding = await this.provisionTenant(projectId, {
      type: 'redis',
      isolationLevel: 'standard',
    });
    return {
      connectionUri: binding.connectionUri,
      username: binding.username,
      password: binding.password,
      keyPrefix: binding.keyPrefix,
    };
  }

  // Deprovisions a specific tenant for any backing service
  async deprovisionTenant(projectId: string, type: string): Promise<void> {
    const normalized = resourceRegistry.normalizeType(type);
    let adapter = resourceRegistry.getAdapter(normalized);
    if (!adapter) {
      adapter = await resourceRegistry.getOrResolveAdapter(normalized).catch(() => undefined);
    }
    if (!adapter) return;

    const resourceId = `res_shared_${normalized}`;
    const [res] = await db
      .select()
      .from(schema.sharedResources)
      .where(eq(schema.sharedResources.id, resourceId));

    if (res) {
      await adapter.deprovisionTenant(res.containerName, projectId);
    }

    await db
      .delete(schema.resourceTenants)
      .where(eq(schema.resourceTenants.projectId, projectId));
  }

  async deprovisionPostgresTenant(projectId: string): Promise<void> {
    return this.deprovisionTenant(projectId, 'postgres');
  }

  async deprovisionRedisTenant(projectId: string): Promise<void> {
    return this.deprovisionTenant(projectId, 'redis');
  }

  // Count active project tenants depending on a shared resource
  async getTenantCount(resourceId: string): Promise<number> {
    const rows = await db
      .select()
      .from(schema.resourceTenants)
      .where(eq(schema.resourceTenants.resourceId, resourceId));
    return rows.length;
  }

  // Safe deletion guard: blocks deletion if applications depend on the shared resource
  async deleteSharedResource(resourceId: string, force = false): Promise<void> {
    const tenantCount = await this.getTenantCount(resourceId);
    if (tenantCount > 0 && !force) {
      throw new Error(
        `Safety Violation: Cannot delete shared resource ${resourceId} while ${tenantCount} project tenant(s) are actively bound.`
      );
    }

    const [res] = await db
      .select()
      .from(schema.sharedResources)
      .where(eq(schema.sharedResources.id, resourceId));

    if (res) {
      await dockerService.stopAndRemove(res.containerName);
      await db
        .update(schema.sharedResources)
        .set({ isActive: false })
        .where(eq(schema.sharedResources.id, resourceId));
    }
  }

  async deleteSharedPostgres(force = false): Promise<void> {
    const tenantCount = await this.getTenantCount('res_shared_postgres');
    if (tenantCount > 0 && !force) {
      throw new Error(
        `Safety Violation: Cannot delete shared PostgreSQL cluster while ${tenantCount} project tenant(s) are actively bound.`
      );
    }
    return this.deleteSharedResource('res_shared_postgres', force);
  }

  // Returns full dependency graph of all shared resources and their bound applications
  async getDependencyGraph(): Promise<Array<{
    resourceId: string;
    resourceType: string;
    containerName: string;
    isActive: boolean;
    tenants: Array<{
      projectId: string;
      databaseName?: string;
      createdAt: number;
    }>;
  }>> {
    const resources = await db.select().from(schema.sharedResources);
    const tenants = await db.select().from(schema.resourceTenants);

    return resources.map((r) => {
      const boundTenants = tenants
        .filter((t) => t.resourceId === r.id)
        .map((t) => ({
          projectId: t.projectId,
          databaseName: t.databaseName || undefined,
          createdAt: t.createdAt,
        }));

      return {
        resourceId: r.id,
        resourceType: r.resourceType,
        containerName: r.containerName,
        isActive: r.isActive,
        tenants: boundTenants,
      };
    });
  }
}

export const resourceManager = new ResourceManager();
