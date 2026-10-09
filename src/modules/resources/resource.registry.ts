import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { ResourceAdapter, ResourceCandidate } from './adapters/resource.adapter.js';
import { postgresAdapter } from './adapters/postgres.adapter.js';
import { redisAdapter } from './adapters/redis.adapter.js';
import { mysqlAdapter } from './adapters/mysql.adapter.js';
import { mongoAdapter } from './adapters/mongodb.adapter.js';
import { rabbitmqAdapter } from './adapters/rabbitmq.adapter.js';
import { minioAdapter } from './adapters/minio.adapter.js';

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
  ]);

  constructor() {
    this.registerAdapter(postgresAdapter);
    this.registerAdapter(redisAdapter);
    this.registerAdapter(mysqlAdapter);
    this.registerAdapter(mongoAdapter);
    this.registerAdapter(rabbitmqAdapter);
    this.registerAdapter(minioAdapter);
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

  listSupportedTypes(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Discovers existing, compatible shared resource instances tracked in the cluster.
   */
  async listCandidates(type: string): Promise<ResourceCandidate[]> {
    const normalized = this.normalizeType(type);
    const adapter = this.getAdapter(normalized);
    if (!adapter) return [];

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
