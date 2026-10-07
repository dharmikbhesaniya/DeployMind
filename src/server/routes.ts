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
