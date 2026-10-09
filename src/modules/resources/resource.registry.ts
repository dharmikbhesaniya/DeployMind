import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { ResourceAdapter, ResourceCandidate } from './adapters/resource.adapter.js';
import { GenericDefinitionAdapter } from './adapters/generic.definition.adapter.js';
import { BUILTIN_SERVICE_DEFINITIONS } from './definitions/service.definition.catalog.js';
import { serviceDefinitionGenerator } from './definitions/service.definition.generator.js';
import type { ServiceDefinition } from './definitions/service.definition.types.js';

export class ResourceRegistry {
  private adapters = new Map<string, ResourceAdapter>();
  private typeAliases = new Map<string, string>([
    ['postgresql', 'postgres'],
    ['pg', 'postgres'],
    ['mariadb', 'mysql'],
    ['mongo', 'mongodb'],
    ['amqp', 'rabbitmq'],
    ['s3', 'minio'],
    ['cache', 'redis'],
    ['clickhouse-server', 'clickhouse'],
    ['neo4j-db', 'neo4j'],
    ['apache-kafka', 'kafka'],
  ]);

  constructor() {
    // Register all service definitions dynamically through GenericDefinitionAdapter
    for (const [key, def] of Object.entries(BUILTIN_SERVICE_DEFINITIONS)) {
      def.status = 'approved';
      this.registerAdapter(new GenericDefinitionAdapter(def));
      for (const alias of def.aliases) {
        this.typeAliases.set(alias.toLowerCase(), def.serviceType.toLowerCase());
      }
    }
  }

  registerAdapter(adapter: ResourceAdapter): void {
    this.adapters.set(adapter.type.toLowerCase(), adapter);
  }

  normalizeType(type: string): string {
    const lower = type.toLowerCase().trim();
    return this.typeAliases.get(lower) || lower;
  }

  getAdapter(type: string): ResourceAdapter | undefined {
    const normalized = this.normalizeType(type);
    return this.adapters.get(normalized);
  }

  /**
   * Dynamically resolves an adapter for ANY technology:
   * If not already registered, researches, generates, validates, and mounts a dynamic adapter on the fly!
   */
  async getOrResolveAdapter(type: string, hint?: string): Promise<ResourceAdapter> {
    const normalized = this.normalizeType(type);
    const existing = this.adapters.get(normalized);
    if (existing) {
      // Check SQLite in case status transitioned (e.g. candidate -> approved / rejected / revoked)
      const [stored] = await db
        .select()
        .from(schema.serviceDefinitions)
        .where(eq(schema.serviceDefinitions.serviceType, normalized));
      if (stored) {
        try {
          const parsed = JSON.parse(stored.definitionPayload) as ServiceDefinition;
          parsed.status = (stored.status as any) || parsed.status || ((existing as any).definition?.provenance?.source === 'builtin' ? 'approved' : undefined);
          (existing as any).definition = parsed;
        } catch {}
      }

      if ((existing as any).definition?.status === 'rejected' || (existing as any).definition?.status === 'revoked') {
        throw new Error(`Service definition for "${normalized}" has been ${(existing as any).definition.status} and cannot be executed.`);
      }
      return existing;
    }

    // Dynamically research and generate definition via AI and catalog discovery
    const definition = await serviceDefinitionGenerator.getOrGenerateDefinition({
      serviceType: normalized,
      contextHint: hint,
    });

    if (definition.status === 'rejected' || definition.status === 'revoked') {
      throw new Error(`Service definition for "${normalized}" has been ${definition.status} and cannot be executed.`);
    }

    const genericAdapter = new GenericDefinitionAdapter(definition);
    this.registerAdapter(genericAdapter);
    for (const alias of definition.aliases) {
      this.typeAliases.set(alias.toLowerCase(), normalized);
    }

    return genericAdapter;
  }

  listSupportedTypes(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Discovers existing, compatible shared resource instances tracked in the cluster.
   */
  async listCandidates(type: string): Promise<ResourceCandidate[]> {
    const normalized = this.normalizeType(type);
    const adapter = await this.getOrResolveAdapter(normalized);

    const rows = await db
      .select()
      .from(schema.sharedResources)
      .where(
        and(
          eq(schema.sharedResources.resourceType, normalized),
          eq(schema.sharedResources.isActive, true)
        )
      );

    const candidates: ResourceCandidate[] = [];

    for (const row of rows) {
      const tenantRows = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.resourceId, row.id));

      let meta: any = {};
      try {
        meta = JSON.parse(row.metadata);
      } catch {
        meta = {};
      }

      // Dedicated instances are never shared across tenants
      if (meta.isDedicated) {
        continue;
      }

      const status = await adapter.checkHealth(row.containerName);

      candidates.push({
        id: row.id,
        type: normalized,
        version: meta.version || 'latest',
        status,
        capacity: {
          availableMemoryMb: meta.maxMemoryMb || 512,
          activeTenants: tenantRows.length,
        },
        capabilities: adapter.capabilities,
        sharingSupported: adapter.sharingSupported,
      });
    }

    return candidates;
  }
}

export const resourceRegistry = new ResourceRegistry();
