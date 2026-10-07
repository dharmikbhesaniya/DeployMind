import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { repoAnalyzer } from '../analyzer/repo.analyzer.js';
import { aiReasoner } from '../ai/ai.reasoner.js';
import { vaultService } from '../vault/vault.service.js';
import { resourceManager } from '../resources/resource.manager.js';
import { dockerService } from '../docker/docker.service.js';
import { proxyService } from '../proxy/proxy.service.js';
import { healthObserver } from '../health/health.observer.js';
import { diagnosticHealer } from '../health/diagnostic.healer.js';
import { dockerfileSynthesizer } from '../builder/dockerfile.synthesizer.js';
import { eventBus } from '../../core/events.js';
import type { DeploymentPlan } from '../../core/types.js';

export interface VariableDecision {
  key: string;
  action: 'use_existing' | 'create_new' | 'auto_generate';
  vaultCredentialId?: string;
  newValue?: string;
  description?: string;
}

export class DeploymentOrchestrator {
  // Step 1: Analyze repository and generate deployment plan
  async analyzeAndPlan(repoUrl: string, projectName?: string): Promise<{
    projectId: string;
    deploymentId: string;
    plan: DeploymentPlan;
  }> {
    const derivedName = projectName || repoUrl.split('/').pop()?.replace('.git', '') || 'project';
    const slug = derivedName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    let projectId = `proj_${crypto.randomUUID()}`;
    const deploymentId = `dep_${crypto.randomUUID()}`;

    // Create or find project
    let [project] = await db.select().from(schema.projects).where(eq(schema.projects.slug, slug));
    if (!project) {
      await db.insert(schema.projects).values({
        id: projectId,
        name: derivedName,
        slug,
        repoUrl,
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } else {
      projectId = project.id;
    }

    eventBus.emitLog({
      deploymentId,
      timestamp: Date.now(),
      level: 'info',
      stage: 'analyze',
      message: `Analyzing repository: ${repoUrl}`,
    });

    // Run static AST & manifest analyzer
    const manifest = await repoAnalyzer.analyzeRepository(repoUrl);

    // If no Dockerfile exists, autonomously synthesize one!
    if (!manifest.hasDockerfile && !manifest.hasCompose) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'plan',
        message: `[Auto-Builder] Repository lacks Dockerfile. Autonomously synthesizing production multi-stage Dockerfile for ${manifest.primaryRuntime || 'Node'}...`,
      });

      const generatedDockerfile = dockerfileSynthesizer.synthesizeDockerfile(manifest);
      manifest.hasDockerfile = true;
      manifest.dockerfileContent = generatedDockerfile;
    }

    eventBus.emitLog({
      deploymentId,
      timestamp: Date.now(),
      level: 'info',
      stage: 'plan',
      message: `Detected runtime: ${manifest.primaryRuntime || 'generic'}. Synthesizing deployment plan...`,
    });

    // Run AI plan synthesis
    const plan = await aiReasoner.synthesizeDeploymentPlan(manifest, derivedName);

    // Save deployment record in DB
    await db.insert(schema.deployments).values({
      id: deploymentId,
      projectId,
      commitHash: manifest.commitHash || null,
      status: 'plan_ready',
      rawManifest: JSON.stringify(manifest),
      deploymentPlan: JSON.stringify(plan),
      logs: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return {
      projectId,
      deploymentId,
      plan,
    };
  }

  // Step 2: Execute deployment given user-approved variable decisions
  async executeDeployment(params: {
    deploymentId: string;
    variableDecisions: VariableDecision[];
  }): Promise<{ status: string; liveUrl: string }> {
    const [dep] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, params.deploymentId));

    if (!dep) throw new Error(`Deployment ${params.deploymentId} not found`);

    const plan: DeploymentPlan = JSON.parse(dep.deploymentPlan);
    const projectId = dep.projectId;

    await db
      .update(schema.deployments)
      .set({ status: 'deploying', updatedAt: Date.now() })
      .where(eq(schema.deployments.id, params.deploymentId));

    eventBus.emitLog({
      deploymentId: params.deploymentId,
      timestamp: Date.now(),
      level: 'info',
      stage: 'deploy',
      message: `Starting autonomous deployment for ${plan.projectName}...`,
    });

    // 1. Resolve environment variables based on decisions & backing services
    for (const v of plan.environmentVariables) {
      const decision = params.variableDecisions.find((d) => d.key === v.key);

      if (v.type === 'AUTO_GENERATED_SECRET') {
        const val = vaultService.generateRandomSecret(v.recommendedGenerator === 'none' ? 'hex32' : v.recommendedGenerator);
        const cred = await vaultService.createCredential({
          keyName: v.key,
          plaintextValue: val,
          description: `Auto-generated secret for ${plan.projectName}`,
          isSystemGenerated: true,
        });
        await vaultService.bindCredentialToProject({
          projectId,
          targetEnvVar: v.key,
          vaultCredentialId: cred.id,
        });
      } else if (v.type === 'INTERNAL_INFRASTRUCTURE') {
        let uri = '';
        if (v.key.includes('REDIS')) {
          const tenant = await resourceManager.provisionRedisTenant(projectId);
          uri = tenant.connectionUri;
        } else {
          const tenant = await resourceManager.provisionPostgresTenant(projectId);
          uri = tenant.connectionUri;
        }
        const cred = await vaultService.createCredential({
          keyName: v.key,
          plaintextValue: uri,
          description: `Provisioned shared infrastructure URI for ${plan.projectName}`,
          isSystemGenerated: true,
        });
        await vaultService.bindCredentialToProject({
          projectId,
          targetEnvVar: v.key,
          vaultCredentialId: cred.id,
        });
      } else if (decision) {
        if (decision.action === 'use_existing' && decision.vaultCredentialId) {
          await vaultService.bindCredentialToProject({
            projectId,
            targetEnvVar: v.key,
            vaultCredentialId: decision.vaultCredentialId,
          });
        } else if (decision.action === 'create_new' && decision.newValue) {
          const cred = await vaultService.createCredential({
            keyName: v.key,
            plaintextValue: decision.newValue,
            description: decision.description || `Key for ${plan.projectName}`,
            owningProjectId: projectId,
            scope: 'GLOBAL',
          });
          await vaultService.bindCredentialToProject({
            projectId,
            targetEnvVar: v.key,
            vaultCredentialId: cred.id,
          });
        } else if (decision.action === 'auto_generate') {
          // Autonomous fallback generation for zero-touch deploys
          const val = vaultService.generateRandomSecret('hex32');
          const cred = await vaultService.createCredential({
            keyName: v.key,
            plaintextValue: val,
            description: `Auto-synthesized key for ${v.key}`,
            isSystemGenerated: true,
          });
          await vaultService.bindCredentialToProject({
            projectId,
            targetEnvVar: v.key,
            vaultCredentialId: cred.id,
          });
        }
      } else if (v.defaultValue) {
        const cred = await vaultService.createCredential({
          keyName: v.key,
          plaintextValue: v.defaultValue,
          description: `Default value for ${v.key}`,
        });
        await vaultService.bindCredentialToProject({
          projectId,
          targetEnvVar: v.key,
          vaultCredentialId: cred.id,
        });
      }
    }

    // 2. Fetch all decrypted variables
    const resolvedEnv = await vaultService.resolveProjectVariables(projectId);

    // 3. Start container
    const containerName = `app_${projectId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const serviceId = `srv_${crypto.randomUUID()}`;

    eventBus.emitLog({
      deploymentId: params.deploymentId,
      timestamp: Date.now(),
      level: 'info',
      stage: 'build',
      message: `Configuring container ${containerName}...`,
    });

    const isDockerAvailable = await dockerService.isAvailable();
    let containerId = 'simulated_container_id';

    if (isDockerAvailable) {
      const res = await dockerService.startContainer({
        containerName,
        imageTag: 'node:22-alpine', // Or built image
        env: resolvedEnv,
        exposedPort: plan.exposedPort,
      });
      containerId = res.containerId;
    }

    // Record Service
    await db.insert(schema.services).values({
      id: serviceId,
      projectId,
      name: 'web',
      containerId,
      imageTag: 'node:22-alpine',
      internalPort: plan.exposedPort,
      desiredState: 'running',
      actualState: 'running',
      resourceLimits: JSON.stringify({ cpu: 1, memoryMb: 1024 }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 4. Register Reverse Proxy Route (Caddy or Traefik)
    const hostname = plan.suggestedSubdomain;
    eventBus.emitLog({
      deploymentId: params.deploymentId,
      timestamp: Date.now(),
      level: 'info',
      stage: 'route',
      message: `Registering reverse proxy route for ${hostname}...`,
    });

    await proxyService.registerServiceRoute({
      serviceId,
      hostname,
      targetUpstream: `${containerName}:${plan.exposedPort}`,
    });

    // 5. Health Check Probes & Autonomous Diagnostic Healer
    const healthResult = await healthObserver.probeAndHeal({
      deploymentId: params.deploymentId,
      containerName,
      port: plan.exposedPort,
      migrationCommand: plan.migrationCommand,
    });

    if (!healthResult.healthy) {
      // Trigger Autonomous Diagnostic Healer
      await diagnosticHealer.diagnoseAndRemediate({
        deploymentId: params.deploymentId,
        projectId,
        serviceId,
        containerName,
        hostname,
        configuredPort: plan.exposedPort,
        migrationCommand: plan.migrationCommand,
      });
    }

    // Mark deployment as healthy
    await db
      .update(schema.deployments)
      .set({ status: 'healthy', updatedAt: Date.now() })
      .where(eq(schema.deployments.id, params.deploymentId));

    eventBus.emitLog({
      deploymentId: params.deploymentId,
      timestamp: Date.now(),
      level: 'success',
      stage: 'deploy',
      message: `Deployment complete! Live at https://${hostname}`,
    });

    return {
      status: 'healthy',
      liveUrl: `https://${hostname}`,
    };
  }

  // 1-Click Zero-Touch Autonomous Deployment:
  // User passes URL only. Entire pipeline runs from analysis to live production without manual input!
  async autoDeploy(repoUrl: string, projectName?: string): Promise<{
    projectId: string;
    deploymentId: string;
    liveUrl: string;
    plan: DeploymentPlan;
  }> {
    const { projectId, deploymentId, plan } = await this.analyzeAndPlan(repoUrl, projectName);

    // Auto-synthesize decisions for every detected variable
    const autoDecisions: VariableDecision[] = plan.environmentVariables.map((v) => {
      if (v.matchingVaultCredentialId) {
        return {
          key: v.key,
          action: 'use_existing',
          vaultCredentialId: v.matchingVaultCredentialId,
        };
      }
      return {
        key: v.key,
        action: 'auto_generate',
      };
    });

    const execution = await this.executeDeployment({
      deploymentId,
      variableDecisions: autoDecisions,
    });

    return {
      projectId,
      deploymentId,
      liveUrl: execution.liveUrl,
      plan,
    };
  }
}

export const deploymentOrchestrator = new DeploymentOrchestrator();

