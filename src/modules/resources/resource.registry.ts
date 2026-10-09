import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { ResourceAdapter, ResourceCandidate } from './adapters/resource.adapter.js';
import { postgresAdapter } from './adapters/postgres.adapter.js';
import { redisAdapter } from './adapters/redis.adapter.js';
import { mysqlAdapter } from './adapters/mysql.adapter.js';
import { mongoAdapter } from './adapters/mongodb.adapter.js';
import { rabbitmqAdapter } from './adapters/rabbitmq.adapter.js';
import { minioAdapter } from './adapters/minio.adapter.js';
import { GenericDefinitionAdapter } from './adapters/generic.definition.adapter.js';
import { BUILTIN_SERVICE_DEFINITIONS } from './definitions/service.definition.catalog.js';
import { serviceDefinitionGenerator } from './definitions/service.definition.generator.js';

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
    // 1. Register baseline adapters
    this.registerAdapter(postgresAdapter);
    this.registerAdapter(redisAdapter);
    this.registerAdapter(mysqlAdapter);
    this.registerAdapter(mongoAdapter);
    this.registerAdapter(rabbitmqAdapter);
    this.registerAdapter(minioAdapter);

    // 2. Register catalog definitions as generic definition adapters
    for (const [key, def] of Object.entries(BUILTIN_SERVICE_DEFINITIONS)) {
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
    if (existing) return existing;

    // Dynamically research and generate definition via AI and catalog discovery
    const definition = await serviceDefinitionGenerator.getOrGenerateDefinition({
      serviceType: normalized,
      contextHint: hint,
    });

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
