import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../../config/index.js';
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
import { nativeRunner } from '../native-runner/native.runner.js';
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

    const repoCheckoutDir = path.join(config.dataDir, 'repos', projectId);

    // Run static AST & manifest analyzer
    const manifest = await repoAnalyzer.analyzeRepository(repoUrl, 'main', repoCheckoutDir);

    // Deep README inspection & understanding
    if (manifest.readmeAnalysis) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'analyze',
        message: `[README Understanding] ${manifest.readmeAnalysis.projectOverview}`,
      });
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'analyze',
        message: `[Architecture & Workflow] ${manifest.readmeAnalysis.howItWorks}`,
      });
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'analyze',
        message: `[Setup Instructions] Workflow: ${manifest.readmeAnalysis.setupWorkflow.join(' -> ')}`,
      });
      if (manifest.readmeAnalysis.detectedBuildCommand) {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'info',
          stage: 'analyze',
          message: `[Detected Production Build] ${manifest.readmeAnalysis.detectedBuildCommand}`,
        });
      }
      if (manifest.readmeAnalysis.detectedStartCommand) {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'info',
          stage: 'analyze',
          message: `[Detected Production Start] ${manifest.readmeAnalysis.detectedStartCommand}`,
        });
      }
    }

    // Check Docker daemon availability to set runtime strategy
    const isDockerOnline = await dockerService.isAvailable();
    if (isDockerOnline) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'plan',
        message: `[Runtime Selection: Priority 1 - Docker] Docker daemon is online and responsive. Containerized isolation enabled.`,
      });
    } else {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'warn',
        stage: 'plan',
        message: `[Runtime Selection: Priority 2 - Native Host Fallback] Docker is offline or not installed. Repository will run directly on host in STRICT PRODUCTION MODE (optimizing CPU, RAM, and disk storage).`,
      });
    }

    // If no Dockerfile exists and Docker is online, autonomously synthesize one!
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

      // Persist synthesized Dockerfile to repo directory if it exists
      try {
        const dockerfilePath = path.join(repoCheckoutDir, 'Dockerfile');
        if (!fs.existsSync(dockerfilePath)) {
          fs.writeFileSync(dockerfilePath, generatedDockerfile, 'utf8');
        }
      } catch {
        // Non-fatal
      }
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
    plan.runtimeStrategy = isDockerOnline ? 'docker_priority' : 'native_production';

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
  }): Promise<{ status: string; liveUrl: string; error?: string }> {
    const [dep] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, params.deploymentId));

    if (!dep) throw new Error(`Deployment ${params.deploymentId} not found`);

    const plan: DeploymentPlan = JSON.parse(dep.deploymentPlan);
    const rawManifest: any = dep.rawManifest ? JSON.parse(dep.rawManifest) : {};
    const projectId = dep.projectId;
    const sourceDir = rawManifest.checkoutDir || path.join(config.dataDir, 'repos', projectId);

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

    // 1. Resolve environment variables: only bind user decisions, Vault reuses, or repository defaults
    const handledKeys = new Set<string>();

    for (const decision of params.variableDecisions) {
      if (!decision.key) continue;
      handledKeys.add(decision.key);

      if (decision.action === 'use_existing' && decision.vaultCredentialId) {
        await vaultService.bindCredentialToProject({
          projectId,
          targetEnvVar: decision.key,
          vaultCredentialId: decision.vaultCredentialId,
        });
      } else if (decision.newValue !== undefined && decision.newValue !== '') {
        const cred = await vaultService.createCredential({
          keyName: decision.key,
          plaintextValue: decision.newValue,
          description: decision.description || `Configured variable for ${plan.projectName}`,
          owningProjectId: projectId,
          scope: 'GLOBAL',
        });
        await vaultService.bindCredentialToProject({
          projectId,
          targetEnvVar: decision.key,
          vaultCredentialId: cred.id,
        });
      }
    }

    // Process any remaining detected variables that have repository default values
    for (const v of plan.environmentVariables) {
      if (!handledKeys.has(v.key) && v.defaultValue) {
        const cred = await vaultService.createCredential({
          keyName: v.key,
          plaintextValue: v.defaultValue,
          description: `Repository default for ${v.key}`,
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

    // 3. Start container or native host runner
    const containerName = `app_${projectId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const serviceId = `srv_${crypto.randomUUID()}`;

    const isDockerAvailable = await dockerService.isAvailable();
    let containerId = 'simulated_container_id';
    let targetUpstream = '';
    let deployedWithDocker = false;

    let activePort = plan.exposedPort;

    if (isDockerAvailable) {
      eventBus.emitLog({
        deploymentId: params.deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'deploy',
        message: `[Runtime Priority 1: Docker] Building container image from repository context...`,
      });

      // Ensure Dockerfile exists in sourceDir (synthesize if missing)
      const dockerfilePath = path.join(sourceDir, 'Dockerfile');
      if (!fs.existsSync(dockerfilePath)) {
        const generated = dockerfileSynthesizer.synthesizeDockerfile(rawManifest);
        try {
          fs.writeFileSync(dockerfilePath, generated, 'utf8');
        } catch {
          // Non-fatal
        }
      }

      const imageTag = `deploymind-${projectId.toLowerCase().replace(/[^a-z0-9]/g, '-')}:latest`;

      const buildResult = await dockerService.buildImage({
        contextDir: sourceDir,
        tag: imageTag,
        onLog: (line) => {
          eventBus.emitLog({
            deploymentId: params.deploymentId,
            timestamp: Date.now(),
            level: 'info',
            stage: 'build',
            message: `[Docker Build] ${line}`,
          });
        },
      });

      if (buildResult.success) {
        eventBus.emitLog({
          deploymentId: params.deploymentId,
          timestamp: Date.now(),
          level: 'success',
          stage: 'deploy',
          message: `[Docker Build] Image ${imageTag} built successfully! Starting container ${containerName}...`,
        });

        try {
          const res = await dockerService.startContainer({
            containerName,
            imageTag,
            env: resolvedEnv,
            exposedPort: plan.exposedPort,
            memoryLimitMb: 1024,
            cpuLimit: 1,
          });
          containerId = res.containerId;
          activePort = res.hostPort;
          targetUpstream = `127.0.0.1:${res.hostPort}`;
          deployedWithDocker = true;
        } catch (startErr: any) {
          eventBus.emitLog({
            deploymentId: params.deploymentId,
            timestamp: Date.now(),
            level: 'error',
            stage: 'deploy',
            message: `Failed to launch container: ${startErr.message}. Falling back to Priority 2 Native Runner...`,
          });
        }
      } else {
        eventBus.emitLog({
          deploymentId: params.deploymentId,
          timestamp: Date.now(),
          level: 'warn',
          stage: 'build',
          message: `Docker image build bypassed: ${buildResult.error || 'Build failed'}. Falling back to Priority 2: Native host runner in strict production mode...`,
        });
      }
    }

    if (!deployedWithDocker) {
      // Allocate isolated, conflict-free port (never 3000 or 5173)
      const freeHostPort = await dockerService.findAvailablePort(4000);
      activePort = freeHostPort;

      // PRIORITY 2: NATIVE HOST RUNNER IN STRICT PRODUCTION MODE
      eventBus.emitLog({
        deploymentId: params.deploymentId,
        timestamp: Date.now(),
        level: 'warn',
        stage: 'deploy',
        message: `[Runtime Priority 2: Native Host Fallback] Executing cloned repository directly on host in STRICT PRODUCTION MODE (port: ${activePort})...`,
      });

      const procInfo = await nativeRunner.startProductionApp({
        deploymentId: params.deploymentId,
        projectId,
        sourceDir,
        env: resolvedEnv,
        port: activePort,
        runtime: plan.runtime,
        buildCommand: plan.readmeSummary?.detectedBuildCommand || plan.migrationCommand,
        startCommand: plan.readmeSummary?.detectedStartCommand || plan.entrypointCommand,
      });
      containerId = `pid_${procInfo.pid}`;
      targetUpstream = `127.0.0.1:${activePort}`;
    }

    // Record Service
    await db.insert(schema.services).values({
      id: serviceId,
      projectId,
      name: 'web',
      containerId,
      imageTag: deployedWithDocker ? 'docker:containerized' : 'native-host:strict-production',
      internalPort: plan.exposedPort,
      desiredState: 'running',
      resourceLimits: JSON.stringify({ cpu: 1, memoryMb: 1024 }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 4. Register Reverse Proxy Route (Caddy or Traefik)
    const hostname = plan.suggestedSubdomain;
    const proxyUpstream = deployedWithDocker
      ? `${containerName}:${plan.exposedPort}`
      : `host.docker.internal:${activePort}`;

    eventBus.emitLog({
      deploymentId: params.deploymentId,
      timestamp: Date.now(),
      level: 'info',
      stage: 'route',
      message: `Registering reverse proxy route for ${hostname} -> ${proxyUpstream}...`,
    });

    await proxyService.registerServiceRoute({
      serviceId,
      hostname,
      targetUpstream: proxyUpstream,
    });

    // 5. Health Check Probes & Autonomous Diagnostic Healer
    const healthResult = await healthObserver.probeAndHeal({
      deploymentId: params.deploymentId,
      containerName,
      port: activePort,
      migrationCommand: plan.migrationCommand,
    });

    if (!healthResult.healthy) {
      // Trigger Autonomous Diagnostic Healer
      const remediation = await diagnosticHealer.diagnoseAndRemediate({
        deploymentId: params.deploymentId,
        projectId,
        serviceId,
        containerName,
        hostname,
        configuredPort: activePort,
        migrationCommand: plan.migrationCommand,
      });

      if (!remediation.remediated) {
        await db
          .update(schema.deployments)
          .set({ status: 'failed', updatedAt: Date.now() })
          .where(eq(schema.deployments.id, params.deploymentId));

        eventBus.emitLog({
          deploymentId: params.deploymentId,
          timestamp: Date.now(),
          level: 'error',
          stage: 'deploy',
          message: `Deployment health check failed on port ${activePort}. Application is not responding: ${healthResult.error || 'Check process logs'}`,
        });

        return {
          status: 'failed',
          liveUrl: '',
          error: healthResult.error || 'Health check failed',
        };
      }
    }

    // Mark deployment as healthy
    await db
      .update(schema.deployments)
      .set({ status: 'healthy', updatedAt: Date.now() })
      .where(eq(schema.deployments.id, params.deploymentId));

    const finalLiveUrl = hostname.endsWith('.localhost') ? `http://${hostname}` : `https://${hostname}`;

    eventBus.emitLog({
      deploymentId: params.deploymentId,
      timestamp: Date.now(),
      level: 'success',
      stage: 'deploy',
      message: `Deployment complete! Live at ${finalLiveUrl} (Direct container port: http://127.0.0.1:${activePort})`,
    });

    return {
      status: 'healthy',
      liveUrl: finalLiveUrl,
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

    // Map decisions for every detected variable using vault reuse or repository default
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
        action: 'create_new',
        newValue: v.defaultValue || '',
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

