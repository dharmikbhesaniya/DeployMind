import crypto from 'node:crypto';
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
   * If a technology is unfamiliar, dynamically synthesizes a verified ServiceDefinition.
   */
  async evaluateRequirement(requirement: ResourceRequirement): Promise<PlanEvaluationResult> {
    const normalizedType = resourceRegistry.normalizeType(requirement.type);
    let adapter = resourceRegistry.getAdapter(normalizedType);

    if (!adapter) {
      try {
        adapter = await resourceRegistry.getOrResolveAdapter(requirement.type);
      } catch (err: any) {
        return {
          decision: {
            action: 'reject',
            reason: `No backing service adapter available and dynamic generation failed for "${requirement.type}": ${err.message}`,
          },
          reasoning: `Unsupported backing service technology "${requirement.type}".`,
        };
      }
    }

    // Policy Check 0: Security Boundary & Approval Gate - Enforce approved status
    const [storedDef] = await db
      .select()
      .from(schema.serviceDefinitions)
      .where(eq(schema.serviceDefinitions.serviceType, normalizedType));

    const defStatus = storedDef?.status || (adapter as any)?.definition?.status;
    if (defStatus === 'rejected' || defStatus === 'revoked') {
      return {
        decision: {
          action: 'reject',
          reason: `Service definition for "${requirement.type}" is ${defStatus} and forbidden from execution.`,
        },
        reasoning: `Backing service "${requirement.type}" definition has been ${defStatus} by security policy.`,
      };
    }

    if (defStatus !== 'approved') {
      return {
        decision: {
          action: 'reject',
          reason: `Service definition for "${requirement.type}" is in "${defStatus || 'candidate'}" status and has not been approved for execution. Operator review and approval are required before provisioning or tenant binding.`,
        },
        reasoning: `Backing service "${requirement.type}" is unapproved (status: ${defStatus || 'candidate'}). Provisioning blocked at execution boundary.`,
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
        reasoning: `${normalizedType} does not support multi-tenant sharing. Provisioning dedicated container instance.`,
      };
    }

    // Policy Check 3: Query active shared cluster candidates
    const candidates = await resourceRegistry.listCandidates(normalizedType);

    // Filter to healthy candidates only (reject degraded and unavailable instances)
    const healthyCandidates = candidates.filter((c) => c.status === 'healthy');

    // Retrieve maximum tenant capacity from definition using nullish handling (protects configured 0 or 1)
    const configuredMax = (adapter as any)?.definition?.multiTenancy?.maxTenantsPerInstance;
    const maxTenants = typeof configuredMax === 'number' && configuredMax >= 0 ? configuredMax : 50;

    // Policy Check 4: Find healthy instance with available capacity
    const healthyCandidate = healthyCandidates.find(
      (c) => (c.capacity.activeTenants || 0) < maxTenants
    );

    if (healthyCandidate) {
      return {
        decision: {
          action: 'reuse',
          resourceId: healthyCandidate.id,
        },
        reasoning: `Found compatible, healthy shared ${normalizedType} instance (${healthyCandidate.id}) with active capacity (${healthyCandidate.capacity.activeTenants || 0} existing tenants). Reusing container on deploymind-net to conserve VPS RAM/CPU footprint.`,
      };
    }

    // If no active shared candidate exists, plan to provision one shared baseline container
    return {
      decision: { action: 'provision', requirement },
      reasoning: `No active shared ${normalizedType} instance found on cluster network. Provisioning baseline shared container to host this and future applications.`,
    };
  }

  /**
   * Executes the planner decision (either reusing existing or provisioning new shared/dedicated instance),
   * binds the isolated tenant, records the dependency in SQLite, and returns connection variables.
   */
  async executeDecision(params: {
    decision: ResourceDecision;
    projectId: string;
    requirement: ResourceRequirement;
  }): Promise<{ binding: ResourceTenantBinding; resourceId: string; reused: boolean }> {
    const { decision, projectId, requirement } = params;
    const normalizedType = resourceRegistry.normalizeType(requirement.type);
    let adapter = resourceRegistry.getAdapter(normalizedType);

    if (!adapter) {
      adapter = await resourceRegistry.getOrResolveAdapter(requirement.type);
    }

    if (decision.action === 'reject') {
      throw new Error(`Resource provisioning rejected: ${decision.reason}`);
    }

    const execStatus = (adapter as any)?.definition?.status;
    if (execStatus && execStatus !== 'approved') {
      throw new Error(
        `Resource execution boundary violation: Backing service definition for "${normalizedType}" has status "${execStatus}" (expected "approved").`
      );
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
      if (normalizedType === 'mongodb' || normalizedType === 'mongo') {
        containerName = 'deploymind-shared-mongo';
      }
      reused = true;
    } else {
      const isDedicated = requirement.isolationLevel === 'dedicated';
      const cleanProj = projectId.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 16);

      if (isDedicated) {
        resourceId = `res_dedicated_${normalizedType}_${cleanProj}_${crypto.randomUUID().slice(0, 8)}`;
      } else {
        resourceId = `res_shared_${normalizedType}`;
      }

      const defaultSharedName =
        normalizedType === 'mongodb' || normalizedType === 'mongo'
          ? 'deploymind-shared-mongo'
          : `deploymind-shared-${normalizedType}`;

      const instanceInfo = await adapter.ensureInstance(resourceId, {
        isDedicated,
        containerName: isDedicated
          ? `deploymind-${normalizedType}-dedicated-${cleanProj}`
          : defaultSharedName,
      });
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
          metadata: JSON.stringify({
            ...(instanceInfo.metadata || {}),
            isDedicated,
          }),
        });
      } else {
        await db
          .update(schema.sharedResources)
          .set({
            isActive: true,
            containerName,
            hostPort: instanceInfo.hostPort,
            metadata: JSON.stringify({
              ...(instanceInfo.metadata || {}),
              isDedicated,
            }),
          })
          .where(eq(schema.sharedResources.id, resourceId));
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
