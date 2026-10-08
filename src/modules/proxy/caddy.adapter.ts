import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';
import { dockerService } from '../docker/docker.service.js';
import type { IngressRoute, ProxyAdapter } from '../../core/types.js';

export class CaddyAdapter implements ProxyAdapter {
  type: 'caddy' = 'caddy';
  private apiUrl: string;

  constructor() {
    this.apiUrl = config.proxy.caddyApiUrl;
  }

  // Native Node.js HTTP request to avoid browser fetch CORS/Sec-Fetch-Mode checks
  private requestCaddy(
    endpoint: string,
    options: { method?: string; body?: any; timeoutMs?: number } = {}
  ): Promise<{ ok: boolean; status: number; data?: any }> {
    return new Promise((resolve) => {
      try {
        const fullUrl = endpoint.startsWith('http') ? endpoint : `${this.apiUrl}${endpoint}`;
        const u = new URL(fullUrl);
        const postData = options.body !== undefined ? JSON.stringify(options.body) : undefined;
        
        const req = http.request(
          {
            hostname: u.hostname,
            port: u.port || 2019,
            path: u.pathname + u.search,
            method: options.method || 'GET',
            headers: {
              ...(postData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
              'User-Agent': 'DeployMind-Proxy-Service/1.0',
            },
            timeout: options.timeoutMs || 2500,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              let parsed: any;
              try {
                parsed = data ? JSON.parse(data) : undefined;
              } catch {
                parsed = data;
              }
              const statusCode = res.statusCode || 0;
              resolve({
                ok: statusCode >= 200 && statusCode < 300,
                status: statusCode,
                data: parsed,
              });
            });
          }
        );

        req.on('error', () => {
          resolve({ ok: false, status: 0 });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({ ok: false, status: 408 });
        });

        if (postData) {
          req.write(postData);
        }
        req.end();
      } catch {
        resolve({ ok: false, status: 0 });
      }
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.requestCaddy('/config/', { method: 'GET', timeoutMs: 1000 });
      if (res.ok) return true;
    } catch {
      // API down, attempt to start Caddy container via Docker
    }

    if (process.env.NODE_ENV === 'test') {
      return false;
    }

    try {
      const ensured = await dockerService.ensureCaddyContainer();
      if (!ensured) return false;

      // Check if Caddy API is now responsive
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const res = await this.requestCaddy('/config/', { method: 'GET', timeoutMs: 1000 });
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

    // Ensure base server and admin origins are properly configured
    await this.ensureBaseServer();

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
      await this.requestCaddy(`/id/${route.routeId}`, { method: 'DELETE', timeoutMs: 1500 });
    } catch {
      // Ignored
    }

    // Also remove any existing route for the exact same hostname to prevent stale port conflicts
    try {
      const existingRoutes = await this.fetchExistingRoutes();
      const duplicateIndex = existingRoutes.findIndex(
        (r) => r.match?.[0]?.host?.includes(route.hostname) && r['@id'] !== route.routeId
      );
      if (duplicateIndex !== -1) {
        await this.requestCaddy(`/config/apps/http/servers/srv0/routes/${duplicateIndex}`, {
          method: 'DELETE',
          timeoutMs: 1500,
        });
      }
    } catch {
      // Ignored
    }

    // Upsert route into Caddy configuration
    try {
      const res = await this.requestCaddy('/config/apps/http/servers/srv0/routes', {
        method: 'POST',
        body: routePayload,
        timeoutMs: 2500,
      });

      if (!res.ok) {
        // If srv0 doesn't exist yet, re-initialize base Caddy HTTP server
        await this.initializeBaseServer();
        await this.requestCaddy('/config/apps/http/servers/srv0/routes', {
          method: 'POST',
          body: routePayload,
          timeoutMs: 2500,
        });
      }

      // Persist active configuration to disk for container restart resilience
      await this.saveConfigToDisk();
    } catch (err: any) {
      console.warn(`[CaddyAdapter] Warning registering route ${route.hostname}:`, err?.message || err);
    }
  }

  async removeRoute(routeId: string): Promise<void> {
    try {
      await this.requestCaddy(`/id/${routeId}`, { method: 'DELETE', timeoutMs: 1500 });
      await this.saveConfigToDisk();
    } catch (err: any) {
      console.warn(`[CaddyAdapter] Warning removing route ${routeId}:`, err?.message || err);
    }
  }

  async listRoutes(): Promise<IngressRoute[]> {
    try {
      const res = await this.requestCaddy('/config/apps/http/servers/srv0/routes');
      if (!res.ok || !Array.isArray(res.data)) return [];
      const routes = res.data as Array<{ '@id'?: string; match?: Array<{ host?: string[] }>; handle?: any }>;

      return routes
        .filter((r) => r['@id'])
        .map((r) => ({
          routeId: r['@id']!,
          hostname: r.match?.[0]?.host?.[0] || 'unknown',
          targetUpstream: 'managed',
          provider: 'caddy' as const,
          sslActive: false,
        }));
    } catch {
      return [];
    }
  }

  async checkCertificateStatus(hostname: string): Promise<{ active: boolean; details?: string }> {
    try {
      const res = await this.requestCaddy('/pki/certificates', { timeoutMs: 2000 });
      return { active: res.ok, details: `Managed by Caddy for ${hostname}` };
    } catch {
      return { active: false, details: 'Caddy local HTTP ingress' };
    }
  }

  private async fetchExistingRoutes(): Promise<any[]> {
    const res = await this.requestCaddy('/config/apps/http/servers/srv0/routes', { timeoutMs: 1500 });
    return Array.isArray(res.data) ? res.data : [];
  }

  private async ensureBaseServer(): Promise<void> {
    try {
      // Ensure origins allow local administrative control
      await this.requestCaddy('/config/admin/origins', {
        method: 'POST',
        body: ['localhost:2019', '127.0.0.1:2019', '*', ''],
      });

      // Ensure srv0 has automatic_https disabled to avoid 308 redirect loops on local domains
      const srvCheck = await this.requestCaddy('/config/apps/http/servers/srv0');
      if (!srvCheck.ok) {
        await this.initializeBaseServer();
      } else {
        if (!srvCheck.data?.automatic_https?.disable) {
          await this.requestCaddy('/config/apps/http/servers/srv0/automatic_https', {
            method: 'PUT',
            body: { disable: true },
          });
        }
        // Ensure root control-plane route exists
        const existingRoutes = Array.isArray(srvCheck.data?.routes) ? srvCheck.data.routes : [];
        const hasControlPlane = existingRoutes.some(
          (r: any) => r['@id'] === 'route_deploymind_control_plane' || r.match?.[0]?.host?.includes('deploymind.localhost')
        );
        if (!hasControlPlane) {
          const controlPlaneRoute = this.getControlPlaneRoute();
          await this.requestCaddy('/config/apps/http/servers/srv0/routes', {
            method: 'POST',
            body: controlPlaneRoute,
          });
        }
      }
    } catch {
      // Best-effort check
    }
  }

  async syncBaseDomain(baseDomain: string): Promise<void> {
    try {
      await this.requestCaddy('/id/route_deploymind_control_plane', { method: 'DELETE', timeoutMs: 1500 });
    } catch {
      // Ignored
    }

    try {
      const route = this.getControlPlaneRoute(baseDomain);
      await this.requestCaddy('/config/apps/http/servers/srv0/routes', {
        method: 'POST',
        body: route,
        timeoutMs: 2500,
      });
      await this.saveConfigToDisk();
    } catch (err: any) {
      console.warn('[CaddyAdapter] Warning updating control plane domain:', err?.message || err);
    }
  }

  private getControlPlaneRoute(baseDomain?: string) {
    const domain = baseDomain || config.proxy.baseDomain;
    const hosts = ['localhost', 'deploymind.localhost'];
    if (domain && domain !== 'localhost') {
      hosts.push(domain, `deploymind.${domain}`);
    }
    return {
      '@id': 'route_deploymind_control_plane',
      match: [{ host: hosts }],
      handle: [
        {
          handler: 'subroute',
          routes: [
            {
              handle: [
                {
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: `host.docker.internal:${config.port}` }],
                },
              ],
            },
          ],
        },
      ],
      terminal: true,
    };
  }

  private async initializeBaseServer(): Promise<void> {
    const baseConfig = {
      listen: [':80'],
      automatic_https: {
        disable: true,
      },
      routes: [this.getControlPlaneRoute()],
    };
    await this.requestCaddy('/config/apps/http/servers/srv0', {
      method: 'PUT',
      body: baseConfig,
    });
  }

  private async saveConfigToDisk(): Promise<void> {
    try {
      const res = await this.requestCaddy('/config/');
      if (res.ok && res.data) {
        const caddyDir = path.resolve('.data/caddy');
        if (!fs.existsSync(caddyDir)) {
          fs.mkdirSync(caddyDir, { recursive: true });
        }
        const caddyJsonPath = path.join(caddyDir, 'caddy.json');
        fs.writeFileSync(caddyJsonPath, JSON.stringify(res.data, null, 2), 'utf8');
      }
    } catch {
      // Non-fatal disk sync error
    }
  }
}
