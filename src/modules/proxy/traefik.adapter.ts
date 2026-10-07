import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';
import type { IngressRoute, ProxyAdapter } from '../../core/types.js';

export class TraefikAdapter implements ProxyAdapter {
  type: 'traefik' = 'traefik';
  private dynamicDir: string;
  private routesFile: string;

  constructor() {
    this.dynamicDir = config.proxy.traefikDynamicDir;
    this.routesFile = path.join(this.dynamicDir, 'deploymind_routes.json');
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.dynamicDir)) {
      fs.mkdirSync(this.dynamicDir, { recursive: true });
    }
  }

  private loadConfig(): {
    http: {
      routers: Record<string, any>;
      services: Record<string, any>;
    };
  } {
    if (fs.existsSync(this.routesFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.routesFile, 'utf8'));
      } catch {
        // Fallback to fresh config if corrupted
      }
    }
    return { http: { routers: {}, services: {} } };
  }

  private saveConfig(data: any): void {
    fs.writeFileSync(this.routesFile, JSON.stringify(data, null, 2), 'utf8');
  }

  async isAvailable(): Promise<boolean> {
    return fs.existsSync(this.dynamicDir);
  }

  async registerRoute(route: IngressRoute): Promise<void> {
    const current = this.loadConfig();
    const routerName = `router-${route.routeId}`;
    const serviceName = `service-${route.routeId}`;

    // Add Traefik HTTP router
    current.http.routers[routerName] = {
      rule: `Host(\`${route.hostname}\`)`,
      service: serviceName,
      entryPoints: ['websecure'],
      tls: {
        certResolver: 'letsencrypt',
      },
    };

    // Add Traefik load balancer service
    current.http.services[serviceName] = {
      loadBalancer: {
        servers: [{ url: `http://${route.targetUpstream}` }],
      },
    };

    this.saveConfig(current);
  }

  async removeRoute(routeId: string): Promise<void> {
    const current = this.loadConfig();
    const routerName = `router-${routeId}`;
    const serviceName = `service-${routeId}`;

    delete current.http.routers[routerName];
    delete current.http.services[serviceName];

    this.saveConfig(current);
  }

  async listRoutes(): Promise<IngressRoute[]> {
    const current = this.loadConfig();
    const results: IngressRoute[] = [];

    for (const [routerName, router] of Object.entries(current.http.routers)) {
      const match = router.rule?.match(/Host\(`([^`]+)`\)/);
      const hostname = match ? match[1] : 'unknown';
      const routeId = routerName.replace('router-', '');

      results.push({
        routeId,
        hostname,
        targetUpstream: 'managed',
        provider: 'traefik',
        sslActive: Boolean(router.tls),
      });
    }

    return results;
  }

  async checkCertificateStatus(hostname: string): Promise<{ active: boolean; details?: string }> {
    return {
      active: true,
      details: `Managed by Traefik ACME resolver for ${hostname}`,
    };
  }
}
