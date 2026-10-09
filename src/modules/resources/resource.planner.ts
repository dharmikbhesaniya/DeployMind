import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { resourceRegistry } from './resource.registry.js';
import type {
  ResourceRequirement,
  ResourceDecision,
  ResourceTenantBinding,
} from './adapters/resource.adapter.js';

export interface PlanEvaluationResult {
  decision: ResourceDecision;
  reasoning: string;
}

export class ResourcePlanner {
  /**
   * Deterministic Policy Engine: Evaluates Compatibility, Capacity, and Isolation
   * to decide whether to REUSE an existing shared container or PROVISION a new one.
   */
  async evaluateRequirement(requirement: ResourceRequirement): Promise<PlanEvaluationResult> {
    const normalizedType = resourceRegistry.normalizeType(requirement.type);
    const adapter = resourceRegistry.getAdapter(normalizedType);

    if (!adapter) {
      return {
        decision: {
          action: 'reject',
          reason: `No backing service adapter available for resource type: "${requirement.type}". Supported types: ${resourceRegistry.listSupportedTypes().join(', ')}`,
        },
        reasoning: `Unsupported backing service technology "${requirement.type}".`,
      };
    }

    // Policy Check 1: If application explicitly demands dedicated isolation
    if (requirement.isolationLevel === 'dedicated') {
      return {
        decision: { action: 'provision', requirement },
        reasoning: `Dedicated isolation requested for ${normalizedType}. Provisioning isolated dedicated container instance.`,
      };
    }

    // Policy Check 2: Check if adapter supports multi-tenant sharing
    if (!adapter.sharingSupported) {
      return {
        decision: { action: 'provision', requirement },
        reasoning: `${normalizedType} adapter does not support multi-tenant sharing. Provisioning dedicated instance.`,
      };
    }

    // Policy Check 3: Query active shared cluster candidates
    const candidates = await resourceRegistry.listCandidates(normalizedType);

    // Policy Check 4: Find healthy instance with available capacity
    const healthyCandidate = candidates.find(
      (c) => c.status !== 'unavailable' && (c.capacity.activeTenants || 0) < 50
    );

    if (healthyCandidate) {
      return {
        decision: {
          action: 'reuse',
          resourceId: healthyCandidate.id,
        },
        reasoning: `Found compatible, healthy shared ${normalizedType} instance (${healthyCandidate.id}) with active capacity (${healthyCandidate.capacity.activeTenants || 0} existing tenants). Reusing container to minimize VPS RAM/CPU footprint.`,
      };
    }

    // If no active candidate exists, plan to provision one shared instance for this technology
    return {
      decision: { action: 'provision', requirement },
      reasoning: `No active shared ${normalizedType} instance found on cluster network. Provisioning baseline shared container to host this and future applications.`,
    };
  }

  /**
   * Executes the planner decision (either reusing existing or provisioning new shared instance),
   * binds the isolated tenant, records the dependency in SQLite, and returns connection variables.
   */
  async executeDecision(params: {
    decision: ResourceDecision;
    projectId: string;
    requirement: ResourceRequirement;
  }): Promise<{ binding: ResourceTenantBinding; resourceId: string; reused: boolean }> {
    const { decision, projectId, requirement } = params;
    const normalizedType = resourceRegistry.normalizeType(requirement.type);
    const adapter = resourceRegistry.getAdapter(normalizedType);

    if (!adapter) {
      throw new Error(`Cannot execute decision: No adapter registered for "${requirement.type}"`);
    }

    if (decision.action === 'reject') {
      throw new Error(`Resource provisioning rejected: ${decision.reason}`);
    }

    let resourceId: string;
    let containerName: string;
    let reused = false;

    if (decision.action === 'reuse') {
      resourceId = decision.resourceId;
      const [existing] = await db
        .select()
        .from(schema.sharedResources)
        .where(eq(schema.sharedResources.id, resourceId));

      if (!existing) {
        throw new Error(`Shared resource ${resourceId} not found in database.`);
      }
      containerName = existing.containerName;
      reused = true;
    } else {
      // Provision baseline container on deploymind-net
      resourceId = `res_shared_${normalizedType}`;
      const instanceInfo = await adapter.ensureInstance(resourceId);
      containerName = instanceInfo.containerName;

      // Track in sharedResources table if not already tracked
      const [existing] = await db
        .select()
        .from(schema.sharedResources)
        .where(eq(schema.sharedResources.id, resourceId));

      if (!existing) {
        await db.insert(schema.sharedResources).values({
          id: resourceId,
          resourceType: normalizedType,
          containerName,
          hostPort: instanceInfo.hostPort,
          isActive: true,
          metadata: JSON.stringify(instanceInfo.metadata),
        });
      }
    }

    // Provision isolated tenant database / credentials
    const binding = await adapter.provisionTenant(containerName, projectId, requirement);

    // Record tenant binding in SQLite
    const tenantId = `ten_${normalizedType.slice(0, 3)}_${projectId.slice(0, 16)}`;
    await db
      .delete(schema.resourceTenants)
      .where(eq(schema.resourceTenants.id, tenantId));

    await db.insert(schema.resourceTenants).values({
      id: tenantId,
      resourceId,
      projectId,
      databaseName: binding.databaseName || null,
      username: binding.username || 'app_user',
      encryptedCredentials: JSON.stringify(binding.credentials),
      createdAt: Date.now(),
    });

    return {
      binding,
      resourceId,
      reused,
    };
  }
}

export const resourcePlanner = new ResourcePlanner();
