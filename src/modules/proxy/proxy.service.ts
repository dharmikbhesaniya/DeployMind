import { eq, or } from 'drizzle-orm';
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

    // Remove existing domain record if any by serviceId or hostname
    await db
      .delete(schema.domains)
      .where(
        or(
          eq(schema.domains.serviceId, params.serviceId),
          eq(schema.domains.hostname, params.hostname)
        )
      );

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

  async bindCustomDomain(params: {
    serviceId: string;
    hostname: string;
    provider?: 'caddy' | 'traefik';
  }): Promise<IngressRoute> {
    const [service] = await db
      .select()
      .from(schema.services)
      .where(eq(schema.services.id, params.serviceId));

    if (!service) {
      throw new Error(`Service not found: ${params.serviceId}`);
    }

    const cleanHostname = params.hostname.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!cleanHostname) {
      throw new Error('Valid hostname is required');
    }

    // Determine upstream target
    let targetUpstream = `host.docker.internal:${service.internalPort}`;
    if (service.containerId && !service.containerId.startsWith('pid_')) {
      targetUpstream = `${service.containerId}:${service.internalPort}`;
    }

    return this.registerServiceRoute({
      serviceId: params.serviceId,
      hostname: cleanHostname,
      targetUpstream,
      provider: params.provider,
    });
  }

  async removeRouteById(routeIdentifier: string): Promise<void> {
    const [existing] = await db
      .select()
      .from(schema.domains)
      .where(eq(schema.domains.routeIdentifier, routeIdentifier));

    if (existing) {
      const adapter = this.getAdapter(existing.proxyProvider as 'caddy' | 'traefik');
      await adapter.removeRoute(existing.routeIdentifier);
      await db.delete(schema.domains).where(eq(schema.domains.id, existing.id));
    }
  }

  async updateBaseDomain(baseDomain: string): Promise<void> {
    config.proxy.baseDomain = baseDomain;
    if (typeof this.caddy.syncBaseDomain === 'function') {
      await this.caddy.syncBaseDomain(baseDomain);
    }
  }

  // Restore and register all persisted routes from SQLite into active proxy engine
  async syncDatabaseRoutes(): Promise<void> {
    const rows = await db.select().from(schema.domains);
    for (const r of rows) {
      try {
        const adapter = this.getAdapter(r.proxyProvider as 'caddy' | 'traefik');
        await adapter.registerRoute({
          routeId: r.routeIdentifier,
          hostname: r.hostname,
          targetUpstream: r.targetUpstream,
          provider: r.proxyProvider as 'caddy' | 'traefik',
          sslActive: Boolean(r.sslActive),
        });
      } catch (err: any) {
        console.warn(`[ProxyService] Could not restore route ${r.hostname}:`, err?.message || err);
      }
    }
  }
}

export const proxyService = new ProxyService();
