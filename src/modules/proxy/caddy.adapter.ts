import { config } from '../../config/index.js';
import type { IngressRoute, ProxyAdapter } from '../../core/types.js';

export class CaddyAdapter implements ProxyAdapter {
  type: 'caddy' = 'caddy';
  private apiUrl: string;

  constructor() {
    this.apiUrl = config.proxy.caddyApiUrl;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/config/`, { method: 'GET', signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async registerRoute(route: IngressRoute): Promise<void> {
    const routePayload = {
      '@id': route.routeId,
      match: [{ host: [route.hostname] }],
      handle: [
        {
          handler: 'subroute',
          routes: [
            {
              handle: [
                {
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: route.targetUpstream }],
                },
              ],
            },
          ],
        },
      ],
      terminal: true,
    };

    // Upsert route into Caddy configuration
    try {
      const res = await fetch(
        `${this.apiUrl}/config/apps/http/servers/srv0/routes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(routePayload),
        }
      );

      if (!res.ok) {
        // If srv0 doesn't exist yet, initialize base Caddy HTTP server
        await this.initializeBaseServer();
        await fetch(
          `${this.apiUrl}/config/apps/http/servers/srv0/routes`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(routePayload),
          }
        );
      }
    } catch (err) {
      console.warn(`[CaddyAdapter] Warning registering route ${route.hostname}:`, err);
    }
  }

  async removeRoute(routeId: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/id/${routeId}`, { method: 'DELETE' });
    } catch (err) {
      console.warn(`[CaddyAdapter] Warning removing route ${routeId}:`, err);
    }
  }

  async listRoutes(): Promise<IngressRoute[]> {
    try {
      const res = await fetch(`${this.apiUrl}/config/apps/http/servers/srv0/routes`);
      if (!res.ok) return [];
      const routes = await res.json() as Array<{ '@id'?: string; match?: Array<{ host?: string[] }>; handle?: any }>;
      
      return routes
        .filter((r) => r['@id'])
        .map((r) => ({
          routeId: r['@id']!,
          hostname: r.match?.[0]?.host?.[0] || 'unknown',
          targetUpstream: 'managed',
          provider: 'caddy' as const,
          sslActive: true,
        }));
    } catch {
      return [];
    }
  }

  async checkCertificateStatus(hostname: string): Promise<{ active: boolean; details?: string }> {
    try {
      const res = await fetch(`${this.apiUrl}/pki/certificates`, { signal: AbortSignal.timeout(2000) });
      return { active: res.ok, details: `Managed by Caddy ACME for ${hostname}` };
    } catch {
      return { active: false, details: 'Caddy not reachable or local self-signed' };
    }
  }

  private async initializeBaseServer(): Promise<void> {
    const baseConfig = {
      listen: [':80', ':443'],
      routes: [],
    };
    await fetch(`${this.apiUrl}/config/apps/http/servers/srv0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseConfig),
    });
  }
}
