import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { config } from '../../config/index.js';
import { CaddyAdapter } from './caddy.adapter.js';
import { TraefikAdapter } from './traefik.adapter.js';
import type { IngressRoute, ProxyAdapter } from '../../core/types.js';

export class ProxyService {
  private caddy: CaddyAdapter;
  private traefik: TraefikAdapter;

  constructor() {
    this.caddy = new CaddyAdapter();
    this.traefik = new TraefikAdapter();
  }

  getAdapter(provider?: 'caddy' | 'traefik'): ProxyAdapter {
    const selected = provider || config.proxy.provider;
    return selected === 'traefik' ? this.traefik : this.caddy;
  }

  async registerServiceRoute(params: {
    serviceId: string;
    hostname: string;
    targetUpstream: string; // e.g. container-name:3000
    provider?: 'caddy' | 'traefik';
  }): Promise<IngressRoute> {
    const provider = params.provider || config.proxy.provider;
    const adapter = this.getAdapter(provider);
    const routeIdentifier = `route_${params.serviceId.slice(0, 16)}`;

    const route: IngressRoute = {
      routeId: routeIdentifier,
      hostname: params.hostname,
      targetUpstream: params.targetUpstream,
      provider,
      sslActive: true,
    };

    // Remove existing domain record if any
    await db.delete(schema.domains).where(eq(schema.domains.serviceId, params.serviceId));

    // Register with active proxy daemon
    await adapter.registerRoute(route);

    // Save in DB
    await db.insert(schema.domains).values({
      id: `dom_${crypto.randomUUID()}`,
      serviceId: params.serviceId,
      hostname: params.hostname,
      proxyProvider: provider,
      routeIdentifier,
      sslActive: true,
      targetUpstream: params.targetUpstream,
      createdAt: Date.now(),
    });

    return route;
  }

  async removeServiceRoute(serviceId: string): Promise<void> {
    const [existing] = await db
      .select()
      .from(schema.domains)
      .where(eq(schema.domains.serviceId, serviceId));

    if (existing) {
      const adapter = this.getAdapter(existing.proxyProvider as 'caddy' | 'traefik');
      await adapter.removeRoute(existing.routeIdentifier);
      await db.delete(schema.domains).where(eq(schema.domains.serviceId, serviceId));
    }
  }

  async listAllRoutes(): Promise<IngressRoute[]> {
    const rows = await db.select().from(schema.domains);
    return rows.map((r) => ({
      routeId: r.routeIdentifier,
      hostname: r.hostname,
      targetUpstream: r.targetUpstream,
      provider: r.proxyProvider as 'caddy' | 'traefik',
      sslActive: Boolean(r.sslActive),
    }));
  }
}

export const proxyService = new ProxyService();
