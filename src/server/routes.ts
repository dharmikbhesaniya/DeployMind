import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { config } from '../config/index.js';
import { db, schema } from '../db/index.js';
import { deploymentOrchestrator } from '../modules/planner/deployment.orchestrator.js';
import { vaultService } from '../modules/vault/vault.service.js';
import { proxyService } from '../modules/proxy/proxy.service.js';
import { dockerService } from '../modules/docker/docker.service.js';
import { backupManager } from '../modules/backup/backup.manager.js';
import { webhookService } from '../modules/webhooks/webhook.service.js';
import { eventBus } from '../core/events.js';
import { resourceManager } from '../modules/resources/resource.manager.js';
import { resourceRegistry } from '../modules/resources/resource.registry.js';

import { aiChatService } from '../modules/ai/chat.service.js';
import { settingsService } from '../modules/settings/settings.service.js';
import { capacityService } from '../modules/system/capacity.service.js';
import { reconcilerService } from '../modules/orchestration/reconciler.service.js';
import { retentionManager } from '../modules/orchestration/retention.manager.js';
import { incidentService } from '../modules/health/incident.service.js';
import { aiTaskEngine } from '../modules/ai/ai.task.engine.js';
import { aiDeploymentExecutor } from '../modules/ai/ai.deployment.executor.js';
import { aiDependencyManager } from '../modules/ai/ai.dependency.manager.js';

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

  // Delete a deployed project with complete cascading teardown of routes, containers, tenants, and state
  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { deleteData?: string };
    const deleteData = query?.deleteData !== 'false';

    try {
      const result = await deploymentOrchestrator.deleteProject(id, { deleteData });
      return {
        success: true,
        message: 'Project and all associated infrastructure was safely torn down.',
        freedResources: result.freedResources,
      };
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message || 'Failed to delete project' });
    }
  });

  // Host Capacity Discovery & Resource Admission
  app.get('/api/system/capacity', async () => {
    return capacityService.getHostMetrics();
  });

  // Manual Trigger for Desired-State Reconciliation Loop
  app.post('/api/orchestration/reconcile', async () => {
    return reconcilerService.reconcile();
  });

  // Active Incidents & Diagnostics
  app.get('/api/incidents', async () => {
    return incidentService.getActiveIncidents();
  });

  // Persistent Infrastructure Audit Trail
  app.get('/api/audit-logs', async () => {
    return db
      .select()
      .from(schema.auditLogs)
      .orderBy(desc(schema.auditLogs.timestamp))
      .limit(50);
  });

  // Automated Artifact & Log Retention Pruning (7-day policy)
  app.post('/api/orchestration/prune', async (req) => {
    const body = req.body as { retentionDays?: number };
    const days = body?.retentionDays || 7;
    return retentionManager.pruneOldArtifacts(days);
  });

  // ============================================================
  // AI Task Engine — Dynamic Command Reasoning & Management
  // ============================================================

  // Inspect a project directory and get AI-synthesized task plan
  // This shows what commands the AI would run for install, build, start, test, and migrate
  app.post('/api/ai/task-plan', async (req, reply) => {
    const body = req.body as { sourceDir?: string; projectId?: string };
    let sourceDir = body?.sourceDir;

    // Resolve from project ID if sourceDir not provided
    if (!sourceDir && body?.projectId) {
      const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.id, body.projectId));
      if (proj) {
        sourceDir = path.join(config.dataDir, 'repos', proj.id);
      }
    }

    if (!sourceDir) {
      return reply.status(400).send({ error: 'sourceDir or projectId is required' });
    }

    try {
      const taskPlan = await aiTaskEngine.synthesizeTaskPlan(sourceDir);
      return taskPlan;
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Task plan synthesis failed' });
    }
  });

  // Check system dependencies for a project
  app.post('/api/ai/dependencies/check', async (req, reply) => {
    const body = req.body as { sourceDir?: string; projectId?: string };
    let sourceDir = body?.sourceDir;

    if (!sourceDir && body?.projectId) {
      const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.id, body.projectId));
      if (proj) {
        sourceDir = path.join(config.dataDir, 'repos', proj.id);
      }
    }

    if (!sourceDir) {
      return reply.status(400).send({ error: 'sourceDir or projectId is required' });
    }

    try {
      const taskPlan = await aiTaskEngine.synthesizeTaskPlan(sourceDir);
      const checks = await aiDependencyManager.analyzeDependencies(taskPlan);
      return {
        taskPlan: {
          runtime: taskPlan.runtime,
          packageManager: taskPlan.packageManager,
          systemDependencies: taskPlan.systemDependencies,
        },
        dependencies: checks,
        allInstalled: checks.every(c => c.installed),
        missingCount: checks.filter(c => !c.installed).length,
      };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Dependency check failed' });
    }
  });

  // Install a specific dependency (respects ASK/AUTO mode)
  app.post('/api/ai/dependencies/install', async (req, reply) => {
    const body = req.body as { name: string; installCommand: string };
    if (!body?.name || !body?.installCommand) {
      return reply.status(400).send({ error: 'name and installCommand are required' });
    }

    try {
      const result = await aiDependencyManager.installDependency({
        name: body.name,
        purpose: '',
        installCommand: body.installCommand,
        checkCommand: '',
        installed: false,
        required: true,
        category: 'system_lib',
      });
      return result;
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Installation failed' });
    }
  });

  // AI-driven test runner: dynamically determine and run tests for a project
  app.post('/api/ai/run-tests', async (req, reply) => {
    const body = req.body as { projectId: string };
    if (!body?.projectId) {
      return reply.status(400).send({ error: 'projectId is required' });
    }

    const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.id, body.projectId));
    if (!proj) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const sourceDir = path.join(config.dataDir, 'repos', proj.id);
    if (!fs.existsSync(sourceDir)) {
      return reply.status(404).send({ error: 'Project source directory not found' });
    }

    try {
      const taskPlan = await aiTaskEngine.synthesizeTaskPlan(sourceDir);
      if (!taskPlan.testCommand) {
        return {
          success: false,
          message: 'No test command could be determined for this project',
          taskPlan: {
            runtime: taskPlan.runtime,
            framework: taskPlan.packageManager,
          },
        };
      }

      // Execute tests in the project directory
      const resolvedEnv = await vaultService.resolveProjectVariables(proj.id);
      const execution = await aiDeploymentExecutor.executeAIDrivenDeployment({
        deploymentId: `test_${crypto.randomUUID()}`,
        projectId: proj.id,
        sourceDir,
        env: resolvedEnv,
        port: 0, // No port needed for tests
        runTests: true,
        runMigrations: false,
      });

      return {
        success: execution.testResult?.success || false,
        testCommand: taskPlan.testCommand,
        exitCode: execution.testResult?.exitCode,
        output: execution.testResult?.output?.slice(-3000),
        duration: execution.testResult?.duration,
        runtime: taskPlan.runtime,
      };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message || 'Test execution failed' });
    }
  });

  // AI-driven service toggle (start/stop with intelligent state management)
  app.post('/api/ai/service-toggle', async (req, reply) => {
    const body = req.body as { projectId: string; action: 'start' | 'stop' | 'restart' };
    if (!body?.projectId || !body?.action) {
      return reply.status(400).send({ error: 'projectId and action (start|stop|restart) are required' });
    }

    const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.id, body.projectId));
    if (!proj) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const servs = await db.select().from(schema.services).where(eq(schema.services.projectId, proj.id));
    const results: any[] = [];

    for (const s of servs) {
      try {
        if (body.action === 'stop' || body.action === 'restart') {
          if (s.containerId && !s.containerId.startsWith('pid_')) {
            await dockerService.stopContainer(s.containerId);
            await db
              .update(schema.services)
              .set({ desiredState: 'stopped', actualState: 'stopped', updatedAt: Date.now() })
              .where(eq(schema.services.id, s.id));
            results.push({ service: s.name, action: 'stopped', containerId: s.containerId });
          } else if (s.containerId?.startsWith('pid_')) {
            aiDeploymentExecutor.stopProcess(proj.id);
            await db
              .update(schema.services)
              .set({ desiredState: 'stopped', actualState: 'stopped', updatedAt: Date.now() })
              .where(eq(schema.services.id, s.id));
            results.push({ service: s.name, action: 'stopped', pid: s.containerId });
          }
        }

        if (body.action === 'start' || body.action === 'restart') {
          let resumedExisting = false;
          if (s.containerId && !s.containerId.startsWith('pid_')) {
            resumedExisting = await dockerService.startExistingContainer(s.containerId);
            if (resumedExisting) {
              await db
                .update(schema.services)
                .set({ desiredState: 'running', actualState: 'running', updatedAt: Date.now() })
                .where(eq(schema.services.id, s.id));
              results.push({ service: s.name, action: 'started', containerId: s.containerId });
            }
          }

          if (!resumedExisting) {
            const sourceDir = path.join(config.dataDir, 'repos', proj.id);
            if (fs.existsSync(sourceDir)) {
              const taskPlan = await aiTaskEngine.synthesizeTaskPlan(sourceDir);
              const resolvedEnv = await vaultService.resolveProjectVariables(proj.id);
              const freePort = await dockerService.findAvailablePort(4000);

              const execution = await aiDeploymentExecutor.executeAIDrivenDeployment({
                deploymentId: `toggle_${crypto.randomUUID()}`,
                projectId: proj.id,
                sourceDir,
                env: resolvedEnv,
                port: freePort,
              });

              if (execution.startResult) {
                await db
                  .update(schema.services)
                  .set({ desiredState: 'running', actualState: 'running', updatedAt: Date.now() })
                  .where(eq(schema.services.id, s.id));
                results.push({
                  service: s.name,
                  action: 'started',
                  pid: execution.startResult.pid,
                  port: execution.startResult.port,
                  command: execution.startResult.command,
                });
              }
            }
          }
        }
      } catch (err: any) {
        results.push({ service: s.name, error: err.message });
      }
    }

    return { success: true, projectId: body.projectId, action: body.action, results };
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

  // --- Generic Backing Resources & Dependency Graph Endpoints ---
  app.get('/api/resources/types', async () => {
    return {
      supportedTypes: resourceRegistry.listSupportedTypes(),
    };
  });

  app.get('/api/resources/dependencies', async () => {
    const graph = await resourceManager.getDependencyGraph();
    return { dependencyGraph: graph };
  });

  app.get('/api/resources/shared', async () => {
    const resources = await db.select().from(schema.sharedResources);
    const tenants = await db.select().from(schema.resourceTenants);
    return resources.map((r) => ({
      ...r,
      activeTenantsCount: tenants.filter((t) => t.resourceId === r.id).length,
    }));
  });

  app.post('/api/resources/shared/ensure', async (req, reply) => {
    const body = req.body as { type: string };
    if (!body?.type) {
      return reply.status(400).send({ error: 'Resource type is required' });
    }
    try {
      const resourceId = await resourceManager.ensureResource(body.type);
      return { success: true, resourceId };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.delete('/api/resources/shared/:resourceId', async (req, reply) => {
    const { resourceId } = req.params as { resourceId: string };
    const query = req.query as { force?: string };
    const force = query?.force === 'true';

    try {
      await resourceManager.deleteSharedResource(resourceId, force);
      return { success: true, message: `Shared resource ${resourceId} removed.` };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
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
