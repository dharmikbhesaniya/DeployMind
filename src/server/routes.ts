import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { deploymentOrchestrator } from '../modules/planner/deployment.orchestrator.js';
import { vaultService } from '../modules/vault/vault.service.js';
import { proxyService } from '../modules/proxy/proxy.service.js';
import { dockerService } from '../modules/docker/docker.service.js';
import { backupManager } from '../modules/backup/backup.manager.js';
import { webhookService } from '../modules/webhooks/webhook.service.js';
import { eventBus } from '../core/events.js';

import { aiChatService } from '../modules/ai/chat.service.js';
import { settingsService } from '../modules/settings/settings.service.js';

export async function registerRoutes(app: FastifyInstance) {
  // System status check
  app.get('/api/system/status', async () => {
    const isDocker = await dockerService.isAvailable();
    const proxyAdapter = proxyService.getAdapter();
    const isProxy = await proxyAdapter.isAvailable();

    return {
      status: 'operational',
      engine: 'DeployMind Modular Monolith',
      version: '0.1.0',
      docker: isDocker ? 'connected' : 'offline',
      proxy: {
        provider: proxyAdapter.type,
        connected: isProxy,
      },
    };
  });

  // System Settings (Access mode ASK vs AUTO)
  app.get('/api/system/settings', async () => {
    return settingsService.getAllSettings();
  });

  app.post('/api/system/settings', async (req, reply) => {
    const body = req.body as { accessMode?: 'ASK' | 'AUTO' };
    if (body?.accessMode) {
      await settingsService.setAccessMode(body.accessMode);
    }
    return settingsService.getAllSettings();
  });

  // Domain Management & Ingress Strategy
  app.get('/api/system/domain', async () => {
    const baseDomain = await settingsService.getBaseDomain();
    return {
      baseDomain,
      isCustom: baseDomain !== 'localhost',
      preview: {
        controlPlane: baseDomain === 'localhost' ? 'http://localhost' : `http://${baseDomain}`,
        subdomainTemplate: `*.${baseDomain}`,
        exampleSubdomain: `recordly.${baseDomain}`,
      },
      dnsGuide: {
        scenarioA: {
          title: 'Dedicated Domain (Root Domain)',
          description: 'Assign the entire root domain to this VPS.',
          records: [
            { type: 'A', name: '@', value: '<YOUR_VPS_PUBLIC_IP>', ttl: '1/2 Hour' },
            { type: 'A', name: '*', value: '<YOUR_VPS_PUBLIC_IP>', ttl: '1/2 Hour' },
          ],
        },
        scenarioB: {
          title: 'Subdomain Delegation (Existing Website)',
          description: 'Keep existing website on root domain untouched; route subdomains through a delegated prefix.',
          records: [
            { type: 'A', name: 'vps', value: '<YOUR_VPS_PUBLIC_IP>', ttl: '1/2 Hour' },
            { type: 'A', name: '*.vps', value: '<YOUR_VPS_PUBLIC_IP>', ttl: '1/2 Hour' },
          ],
        },
      },
    };
  });

  app.post('/api/system/domain', async (req, reply) => {
    const body = req.body as { baseDomain: string };
    if (!body?.baseDomain || typeof body.baseDomain !== 'string') {
      return reply.status(400).send({ error: 'baseDomain is required' });
    }

    try {
      const updated = await settingsService.setBaseDomain(body.baseDomain);
      await proxyService.updateBaseDomain(updated);
      return {
        success: true,
        baseDomain: updated,
        message: `Base domain updated to "${updated}". All new deployments will generate *.${updated} subdomains.`,
      };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Failed to update base domain' });
    }
  });

  // Interactive AI Agent Chat (TypeSafe Jev + ChatGPT)
  app.post('/api/ai/chat', async (req, reply) => {
    const body = req.body as { message: string; history?: any[] };
    if (!body?.message) {
      return reply.status(400).send({ error: 'message is required' });
    }

    try {
      const response = await aiChatService.processUserMessage(body.message, body.history || []);
      return response;
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'AI Chat processing error' });
    }
  });

  // Interactive Claude Code Confirmation (Approve / Deny + Variables + Auto Mode)
  app.post('/api/ai/chat/confirm', async (req, reply) => {
    const body = req.body as {
      promptId: string;
      approved: boolean;
      variables?: Record<string, string>;
      enableAutoMode?: boolean;
    };
    if (!body?.promptId) {
      return reply.status(400).send({ error: 'promptId is required' });
    }

    try {
      const result = await aiChatService.handleConfirmation(body.promptId, Boolean(body.approved), {
        variables: body.variables,
        enableAutoMode: body.enableAutoMode,
      });
      return result;
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Confirmation handling error' });
    }
  });

  // 1-Click Zero-Touch Autonomous Deployment (URL Only!)
  app.post('/api/deployments/auto-deploy', async (req, reply) => {
    const body = req.body as { repoUrl: string; projectName?: string };
    if (!body?.repoUrl) {
      return reply.status(400).send({ error: 'repoUrl is required' });
    }

    try {
      const result = await deploymentOrchestrator.autoDeploy(body.repoUrl, body.projectName);
      return result;
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Auto-deployment failed' });
    }
  });

  // Analyze a Git repository
  app.post('/api/deployments/analyze', async (req, reply) => {
    const body = req.body as { repoUrl: string; projectName?: string };
    if (!body?.repoUrl) {
      return reply.status(400).send({ error: 'repoUrl is required' });
    }

    try {
      const result = await deploymentOrchestrator.analyzeAndPlan(body.repoUrl, body.projectName);
      return result;
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Analysis failed' });
    }
  });

  // Execute an approved deployment
  app.post('/api/deployments/execute', async (req, reply) => {
    const body = req.body as { deploymentId: string; variableDecisions: any[] };
    if (!body?.deploymentId) {
      return reply.status(400).send({ error: 'deploymentId is required' });
    }

    try {
      const result = await deploymentOrchestrator.executeDeployment({
        deploymentId: body.deploymentId,
        variableDecisions: body.variableDecisions || [],
      });
      return result;
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Execution failed' });
    }
  });

  // Get Deployment Status & Details
  app.get('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id));
    if (!dep) {
      return reply.status(404).send({ error: 'Deployment not found' });
    }
    let plan = null;
    try {
      plan = JSON.parse(dep.deploymentPlan);
    } catch {
      // ignore
    }
    return {
      id: dep.id,
      projectId: dep.projectId,
      status: dep.status,
      plan,
      createdAt: dep.createdAt,
      updatedAt: dep.updatedAt,
    };
  });

  // Git Push-to-Deploy Webhook Endpoint
  app.post('/api/webhooks/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    try {
      const result = await webhookService.handlePushEvent(projectId, req.body);
      return result;
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Webhook processing failed' });
    }
  });

  // List Backups
  app.get('/api/backups', async () => {
    return backupManager.listBackups();
  });

  // Run On-Demand Backup
  app.post('/api/backups/run', async () => {
    const backups = await backupManager.runAutomatedBackup();
    return { success: true, created: backups };
  });

  // List all deployed projects
  app.get('/api/projects', async () => {
    const projectsList = await db
      .select()
      .from(schema.projects)
      .orderBy(desc(schema.projects.createdAt));

    const results = [];
    for (const p of projectsList) {
      // Exclude DeployMind itself from the managed projects list
      const slugLower = (p.slug || '').toLowerCase();
      const nameLower = (p.name || '').toLowerCase();
      const repoLower = (p.repoUrl || '').toLowerCase();
      if (
        slugLower.includes('deploymind') ||
        slugLower.includes('deployagent') ||
        nameLower.includes('deploymind') ||
        nameLower.includes('deployagent') ||
        repoLower.includes('dharmikbhesaniya/deploymind')
      ) {
        continue;
      }

      const servs = await db.select().from(schema.services).where(eq(schema.services.projectId, p.id));
      const deps = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.projectId, p.id))
        .orderBy(desc(schema.deployments.createdAt))
        .limit(1);

      const latestStatus = deps[0]?.status || 'created';

      // Only display projects that have completed deployment or have active services
      if (servs.length === 0 && latestStatus !== 'healthy' && latestStatus !== 'deploying') {
        continue;
      }

      results.push({
        ...p,
        servicesCount: servs.length,
        status: latestStatus,
      });
    }

    return results;
  });

  // Delete a deployed project and purge all containers, volumes, routes, and records
  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    try {
      // 1. Terminate and remove all Docker containers and proxy routes
      const servs = await db.select().from(schema.services).where(eq(schema.services.projectId, id));
      for (const s of servs) {
        if (s.containerId && !s.containerId.startsWith('pid_')) {
          await dockerService.stopAndRemove(s.containerId).catch(() => {});
        }
        await proxyService.removeServiceRoute(s.id).catch(() => {});
      }

      // 2. Remove deployments and project record
      await db.delete(schema.deployments).where(eq(schema.deployments.projectId, id)).catch(() => {});
      await db.delete(schema.services).where(eq(schema.services.projectId, id)).catch(() => {});
      await db.delete(schema.projects).where(eq(schema.projects.id, id));

      return {
        success: true,
        message: `Project "${project.name}" and all associated containers, data, and routes were deleted.`,
      };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Failed to delete project' });
    }
  });

  // List all credentials in the Vault
  app.get('/api/vault/credentials', async () => {
    const rows = await db
      .select()
      .from(schema.vaultCredentials)
      .orderBy(desc(schema.vaultCredentials.createdAt));

    const results = [];
    for (const r of rows) {
      const bindings = await db
        .select()
        .from(schema.projectCredentialBindings)
        .where(eq(schema.projectCredentialBindings.vaultCredentialId, r.id));

      results.push({
        id: r.id,
        keyName: r.keyName,
        description: r.description,
        maskedPreview: r.maskedPreview,
        scope: r.scope,
        owningProjectId: r.owningProjectId,
        isSystemGenerated: Boolean(r.isSystemGenerated),
        boundProjectsCount: bindings.length,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      });
    }
    return results;
  });

  // Create a credential directly in the Vault (supports duplicate key names!)
  app.post('/api/vault/credentials', async (req, reply) => {
    const body = req.body as {
      keyName: string;
      value: string;
      description: string;
      scope?: 'GLOBAL' | 'PROJECT_SCOPED';
    };

    if (!body?.keyName || !body?.value || !body?.description) {
      return reply.status(400).send({ error: 'keyName, value, and description are required' });
    }

    const created = await vaultService.createCredential({
      keyName: body.keyName,
      plaintextValue: body.value,
      description: body.description,
      scope: body.scope,
    });

    return created;
  });

  // List all proxy routes
  app.get('/api/routes', async () => {
    return proxyService.listAllRoutes();
  });

  // Bind custom domain or custom subdomain to a deployed service
  app.post('/api/routes/custom', async (req, reply) => {
    const body = req.body as { serviceId: string; hostname: string };
    if (!body?.serviceId || !body?.hostname) {
      return reply.status(400).send({ error: 'serviceId and hostname are required' });
    }

    try {
      const route = await proxyService.bindCustomDomain({
        serviceId: body.serviceId,
        hostname: body.hostname,
      });
      return { success: true, route };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Failed to bind custom domain' });
    }
  });

  // Remove proxy route by route identifier
  app.delete('/api/routes/:routeIdentifier', async (req, reply) => {
    const { routeIdentifier } = req.params as { routeIdentifier: string };
    try {
      await proxyService.removeRouteById(routeIdentifier);
      return { success: true };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Failed to remove route' });
    }
  });

  // WebSocket for real-time deployment logs
  app.get('/ws/logs', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const deploymentId = url.searchParams.get('deploymentId');

    const listener = (log: any) => {
      if (!deploymentId || log.deploymentId === deploymentId) {
        socket.send(JSON.stringify(log));
      }
    };

    eventBus.onLog(listener);

    socket.on('close', () => {
      eventBus.off('deployment:log', listener);
    });
  });
}
