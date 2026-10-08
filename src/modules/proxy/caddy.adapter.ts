import { config } from '../../config/index.js';
import { dockerService } from '../docker/docker.service.js';
import type { IngressRoute, ProxyAdapter } from '../../core/types.js';

export class CaddyAdapter implements ProxyAdapter {
  type: 'caddy' = 'caddy';
  private apiUrl: string;

  constructor() {
    this.apiUrl = config.proxy.caddyApiUrl;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/config/`, { method: 'GET', signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // API down, attempt to start Caddy container via Docker
    }

    try {
      const ensured = await dockerService.ensureCaddyContainer();
      if (!ensured) return false;

      // Check if Caddy API is now responsive
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const res = await fetch(`${this.apiUrl}/config/`, { method: 'GET', signal: AbortSignal.timeout(1000) });
          if (res.ok) return true;
        } catch {
          // retry
        }
      }
    } catch {
      return false;
    }

    return false;
  }

  async registerRoute(route: IngressRoute): Promise<void> {
    // Ensure Caddy is online before posting
    await this.isAvailable();

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

    // Remove existing route by id first to ensure idempotent upsert
    try {
      await fetch(`${this.apiUrl}/id/${route.routeId}`, { method: 'DELETE', signal: AbortSignal.timeout(1500) });
    } catch {
      // Ignored
    }

    // Upsert route into Caddy configuration
    try {
      const res = await fetch(
        `${this.apiUrl}/config/apps/http/servers/srv0/routes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(routePayload),
          signal: AbortSignal.timeout(2500),
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
            signal: AbortSignal.timeout(2500),
          }
        );
      }
    } catch (err: any) {
      console.warn(`[CaddyAdapter] Warning registering route ${route.hostname}:`, err?.message || err);
    }
  }

  async removeRoute(routeId: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/id/${routeId}`, { method: 'DELETE', signal: AbortSignal.timeout(1500) });
    } catch (err: any) {
      console.warn(`[CaddyAdapter] Warning removing route ${routeId}:`, err?.message || err);
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
