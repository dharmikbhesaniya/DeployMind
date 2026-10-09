/**
 * DeployMind Interactive AI Agent Service
 * Orchestrates TypeSafe Jev (System 1) + ChatGPT (System 2) + Live Docker/Database Operations.
 * Delivers Claude Code-style interactive desktop experience in natural language.
 */

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { dockerService } from '../docker/docker.service.js';
import { proxyService } from '../proxy/proxy.service.js';
import { deploymentOrchestrator } from '../planner/deployment.orchestrator.js';
import { vaultService } from '../vault/vault.service.js';
import { settingsService } from '../settings/settings.service.js';
import { jevEvaluator, type JevIntentDecision } from './jev.evaluator.js';
import { chatGPTReasoner, type ChatMessage } from './chatgpt.reasoner.js';

export interface InteractivePrompt {
  id: string;
  type: 'permission_request' | 'variable_request';
  title: string;
  action: string;
  target: string;
  details: string;
  riskLevel: 'SAFE' | 'CAUTION' | 'DESTRUCTIVE';
  confidence: number;
  deploymentId?: string;
  projectId?: string;
  repoUrl?: string;
  missingVariables?: Array<{
    key: string;
    description: string;
    defaultValue?: string;
    type: string;
  }>;
  requiredTools?: Array<{
    name: string;
    purpose: string;
    commandOrPackage: string;
  }>;
  accessMode?: 'ASK' | 'AUTO';
}

export interface ChatResponsePayload {
  message: string;
  intent: JevIntentDecision;
  interactivePrompt?: InteractivePrompt;
  actionResult?: {
    action: string;
    success: boolean;
    output?: any;
    error?: string;
  };
}

// In-memory pending prompts map for interactive confirmation
const pendingPrompts = new Map<string, {
  action: string;
  target: string;
  details: any;
  createdAt: number;
}>();

export class AIChatService {
  async processUserMessage(
    userMessage: string,
    history: ChatMessage[] = []
  ): Promise<ChatResponsePayload> {
    // 1. Gather real-time system context
    const projects = await db.select().from(schema.projects);
    const services = await db.select().from(schema.services);
    const routes = await proxyService.listAllRoutes();

    const systemContext = {
      activeProjects: projects.map((p) => {
        const projService = services.find((s) => s.projectId === p.id);
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          repoUrl: p.repoUrl,
          status: projService?.actualState || 'active',
        };
      }),
      activeServices: services.map((s) => ({
        id: s.id,
        name: s.name,
        containerId: s.containerId || undefined,
        status: s.actualState,
      })),
      activeRoutes: routes.map((r) => ({
        hostname: r.hostname,
        targetUpstream: r.targetUpstream,
      })),
    };

    // 2. TypeSafe Jev (System 1) Evaluation: Classify intent & evaluate risk in <100ms
    const intent = await jevEvaluator.evaluateIntent(userMessage, {
      projects: projects.map((p) => p.slug || p.name),
      services: services.map((s) => s.name),
    });

    // 3. Risk Evaluation & Claude Code-style interactive confirmation guardrail
    if (intent.requiresPermission) {
      const risk = await jevEvaluator.evaluateRisk(intent.choice, intent.entities.projectName || intent.entities.serviceName || 'system');
      const promptId = `prompt_${crypto.randomUUID()}`;

      const prompt: InteractivePrompt = {
        id: promptId,
        type: 'permission_request',
        title: `Permission Required: ${intent.choice.replace('_', ' ')}`,
        action: intent.choice,
        target: intent.entities.projectName || intent.entities.serviceName || 'target',
        details: risk.impactAssessment,
        riskLevel: intent.riskLevel,
        confidence: Math.round(risk.calibratedConfidence * 100),
      };

      pendingPrompts.set(promptId, {
        action: intent.choice,
        target: prompt.target,
        details: intent.entities,
        createdAt: Date.now(),
      });

      return {
        message: `⚠️ **Action Requires Permission**: TypeSafe Jev flagged this operation as **${intent.riskLevel}** (confidence: ${Math.round(risk.calibratedConfidence * 100)}%).\n\n${risk.impactAssessment}`,
        intent,
        interactivePrompt: prompt,
      };
    }

    // 4. Safe Operational Execution
    let actionResult: ChatResponsePayload['actionResult'];

    try {
      if (intent.choice === 'GET_LOGS') {
        const target = intent.entities.serviceName || intent.entities.projectName || '';
        // Find matching container name
        let containerTarget = '';
        const matchedServ = services.find((s) => s.name.toLowerCase().includes(target.toLowerCase()) || (s.containerId && s.containerId.includes(target)));
        if (matchedServ?.containerId && !matchedServ.containerId.startsWith('pid_')) {
          containerTarget = matchedServ.containerId;
        } else {
          // Check running docker containers
          containerTarget = `app_proj_${target}`;
        }

        const logs = await dockerService.getContainerLogs(containerTarget, 100);
        actionResult = {
          action: 'GET_LOGS',
          success: true,
          output: logs || `No live logs found for container ${containerTarget}.`,
        };
      } else if (intent.choice === 'START_SERVICE') {
        const target = intent.entities.serviceName || '';
        const serv = services.find((s) => s.name.toLowerCase().includes(target.toLowerCase()));
        if (serv?.containerId && !serv.containerId.startsWith('pid_')) {
          const started = await dockerService.startExistingContainer(serv.containerId);
          if (!started) {
            await dockerService.startContainer({
              containerName: serv.containerId,
              imageTag: serv.imageTag,
              env: {},
              exposedPort: serv.internalPort,
            });
          }
          await db
            .update(schema.services)
            .set({ desiredState: 'running', actualState: 'running', updatedAt: Date.now() })
            .where(eq(schema.services.id, serv.id));
        }
        actionResult = { action: 'START_SERVICE', success: true, output: `Started ${target}` };
      } else if (intent.choice === 'STOP_SERVICE') {
        const target = intent.entities.serviceName || '';
        const serv = services.find((s) => s.name.toLowerCase().includes(target.toLowerCase()));
        if (serv?.containerId && !serv.containerId.startsWith('pid_')) {
          await dockerService.stopContainer(serv.containerId);
          await db
            .update(schema.services)
            .set({ desiredState: 'stopped', actualState: 'stopped', updatedAt: Date.now() })
            .where(eq(schema.services.id, serv.id));
        }
        actionResult = { action: 'STOP_SERVICE', success: true, output: `Stopped ${target}` };
      } else if (intent.choice === 'SYSTEM_STATUS') {
        actionResult = { action: 'SYSTEM_STATUS', success: true, output: systemContext };
      } else if (intent.choice === 'DEPLOY') {
        let repoUrl = intent.entities.repoUrl;
        if (!repoUrl && intent.entities.projectName) {
          const matchedProj = projects.find(
            (p) =>
              p.slug.includes(intent.entities.projectName!.toLowerCase()) ||
              p.name.toLowerCase().includes(intent.entities.projectName!.toLowerCase())
          );
          if (matchedProj?.repoUrl) {
            repoUrl = matchedProj.repoUrl;
          }
        }

        if (!repoUrl) {
          actionResult = {
            action: 'DEPLOY',
            success: false,
            error: 'Please provide a Git repository URL to deploy (e.g. "Deploy https://github.com/webadderallorg/Recordly").',
          };
        } else {
          const { projectId, deploymentId, plan } = await deploymentOrchestrator.analyzeAndPlan(repoUrl);

          // 1. Detect missing or unconfigured environment variables
          const missingVars: Array<{
            key: string;
            description: string;
            defaultValue?: string;
            type: string;
          }> = [];

          for (const v of plan.environmentVariables) {
            if (v.matchingVaultCredentialId) continue;

            const val = (v.defaultValue || '').trim();
            const isPlaceholder = /YOUR_|sb_publishable_|<placeholder>|example|changeme|xxx/i.test(val);
            const isRequiredKey = /KEY|SECRET|TOKEN|AUTH|PASS|PASSWORD|DATABASE_URL|SUPABASE|API/i.test(v.key);

            if (v.type === 'EXTERNAL_REQUIRED' || !val || isPlaceholder || isRequiredKey) {
              missingVars.push({
                key: v.key,
                description: v.description || `Required environment variable: ${v.key}`,
                defaultValue: isPlaceholder ? '' : val,
                type: v.type,
              });
            }
          }

          // 2. Detect required tool and application dependencies
          const requiredTools: Array<{
            name: string;
            purpose: string;
            commandOrPackage: string;
          }> = [];

          const isDockerOnline = await dockerService.isAvailable();
          if (isDockerOnline) {
            requiredTools.push({
              name: `${plan.runtime === 'python' ? 'Python 3.12' : 'Node.js 22'} Container Runtime`,
              purpose: 'Provides isolated execution sandbox with required language binaries and libraries.',
              commandOrPackage: plan.runtime === 'python' ? 'docker pull python:3.12-slim' : 'docker pull node:22-bookworm-slim',
            });
          }

          const rawManifestStr = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)))[0]?.rawManifest;
          const manifestObj = rawManifestStr ? JSON.parse(rawManifestStr) : null;
          const manifestSummary = JSON.stringify(manifestObj || {});

          if (manifestSummary.includes('ffmpeg') || manifestSummary.includes('capturekit')) {
            requiredTools.push({
              name: 'FFmpeg Media Binaries',
              purpose: 'Required for high-performance screen recording, video transcoding, and media processing.',
              commandOrPackage: 'ffmpeg-static / ffprobe-static',
            });
          }

          if (manifestSummary.includes('pnpm')) {
            requiredTools.push({
              name: 'pnpm Package Engine',
              purpose: 'Fast, disk-efficient dependency manager required by repository lockfile.',
              commandOrPackage: 'corepack enable && pnpm install',
            });
          }

          const accessMode = await settingsService.getAccessMode();
          const needsVariableInput = missingVars.length > 0;
          const needsToolApproval = requiredTools.length > 0 && accessMode === 'ASK';

          // If keys are missing OR tools need approval in ASK mode: PAUSE AND ASK USER PROPERLY
          if (needsVariableInput || needsToolApproval) {
            const promptId = `prompt_dep_${deploymentId}`;
            const prompt: InteractivePrompt = {
              id: promptId,
              type: 'variable_request',
              title: needsVariableInput
                ? `Required Keys & Dependencies: ${plan.projectName}`
                : `Tool Download Approval: ${plan.projectName}`,
              action: 'DEPLOY_CONFIRM',
              target: repoUrl,
              details: needsVariableInput
                ? `Repository requires ${missingVars.length} environment keys or dependencies before launch. Configure them below to proceed.`
                : `DeployMind is in ASK Mode. Please approve downloading ${requiredTools.length} tool dependencies.`,
              riskLevel: 'CAUTION',
              confidence: 99,
              deploymentId,
              projectId,
              repoUrl,
              missingVariables: missingVars,
              requiredTools,
              accessMode,
            };

            const planHash = crypto
              .createHash('sha256')
              .update(JSON.stringify(plan))
              .digest('hex');

            await db
              .delete(schema.pendingApprovals)
              .where(eq(schema.pendingApprovals.id, promptId));

            await db.insert(schema.pendingApprovals).values({
              id: promptId,
              action: 'DEPLOY_CONFIRM',
              target: repoUrl,
              planHash,
              details: JSON.stringify({
                deploymentId,
                projectId,
                plan,
                missingVars,
                requiredTools,
              }),
              status: 'pending',
              createdAt: Date.now(),
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            });

            pendingPrompts.set(promptId, {
              action: 'DEPLOY_CONFIRM',
              target: repoUrl,
              details: {
                deploymentId,
                projectId,
                plan,
                missingVars,
                requiredTools,
              },
              createdAt: Date.now(),
            });

            return {
              message: needsVariableInput
                ? `✋ **Deployment Paused — Configuration Required**\n\nThe project at \`${repoUrl}\` requires environment keys before it can run safely. Please configure them below to proceed.\n\n*(Tip: You can switch to **AUTO Mode** at any time to approve tool downloads automatically).*`
                : `🛡️ **Tool Download Approval Required**\n\nDeployMind is currently in **ASK Mode**. Review the required tool dependencies below to approve installation and launch the service.`,
              intent,
              interactivePrompt: prompt,
            };
          }

          // Otherwise (all keys present and AUTO full-access mode): Execute deployment directly
          deploymentOrchestrator
            .executeDeployment({
              deploymentId,
              variableDecisions: plan.environmentVariables.map((v) => ({
                key: v.key,
                action: v.matchingVaultCredentialId ? 'use_existing' : 'create_new',
                vaultCredentialId: v.matchingVaultCredentialId,
                newValue: v.defaultValue || '',
              })),
            })
            .catch((err: any) => {
              console.error('[ChatService] Background deployment error:', err?.message || err);
            });

          actionResult = {
            action: 'DEPLOY',
            success: true,
            output: {
              deploymentId,
              projectId,
              repoUrl,
              subdomain: plan.suggestedSubdomain,
              plan,
            },
          };
        }
      } else if (intent.choice === 'SET_MODE') {
        const targetMode = intent.entities.mode || 'ASK';
        await settingsService.setAccessMode(targetMode);
        actionResult = {
          action: 'SET_MODE',
          success: true,
          output: `System execution access mode set to **${targetMode}** (${
            targetMode === 'AUTO'
              ? '⚡ Full Access: Tool dependencies download and install automatically'
              : '🛡️ ASK Mode: DeployMind will ask for your approval before downloading any tools or dependencies'
          }).`,
        };
      } else if (intent.choice === 'CONFIGURE_ENV' && intent.entities.envKey && intent.entities.envValue) {
        await vaultService.createCredential({
          keyName: intent.entities.envKey,
          plaintextValue: intent.entities.envValue,
          description: `Configured via AI Chat for system runtime`,
        });
        actionResult = {
          action: 'CONFIGURE_ENV',
          success: true,
          output: `Saved ${intent.entities.envKey} securely in Vault.`,
        };
      }
    } catch (err: any) {
      console.error('[ChatService] Error executing intent:', intent.choice, err);
      actionResult = {
        action: intent.choice,
        success: false,
        error: err.message,
      };
    }

    // 5. ChatGPT (System 2) Conversational Synthesis
    const assistantMessage = await chatGPTReasoner.generateResponse(
      userMessage,
      history,
      systemContext,
      actionResult
    );

    return {
      message: assistantMessage,
      intent,
      actionResult,
    };
  }

  // Handle Claude Code-style interactive confirmation (Approve / Deny)
  async handleConfirmation(
    promptId: string,
    approved: boolean,
    options?: {
      variables?: Record<string, string>;
      enableAutoMode?: boolean;
    }
  ): Promise<{ success: boolean; message: string; deploymentStream?: any }> {
    // Check durable pending approvals in SQLite
    const [durableApproval] = await db
      .select()
      .from(schema.pendingApprovals)
      .where(eq(schema.pendingApprovals.id, promptId));

    const prompt = pendingPrompts.get(promptId);
    pendingPrompts.delete(promptId);

    if (!durableApproval && !prompt) {
      return { success: false, message: 'Interactive prompt has expired or was already handled.' };
    }

    const action = durableApproval?.action || prompt?.action;
    const target = durableApproval?.target || prompt?.target || '';
    const details = durableApproval ? JSON.parse(durableApproval.details) : prompt?.details;

    if (durableApproval) {
      if (durableApproval.status !== 'pending' || durableApproval.expiresAt < Date.now()) {
        return { success: false, message: 'Interactive prompt has expired or was already handled.' };
      }
    }

    if (!approved) {
      if (durableApproval) {
        await db
          .update(schema.pendingApprovals)
          .set({ status: 'rejected' })
          .where(eq(schema.pendingApprovals.id, promptId));
      }
      return { success: true, message: `Action "${action}" was cancelled by user.` };
    }

    // Verify cryptographic immutable plan hash
    if (durableApproval?.planHash && details?.plan) {
      const currentPlanHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(details.plan))
        .digest('hex');

      if (currentPlanHash !== durableApproval.planHash) {
        await db
          .update(schema.pendingApprovals)
          .set({ status: 'rejected' })
          .where(eq(schema.pendingApprovals.id, promptId));
        return {
          success: false,
          message: 'Plan integrity failure: Deployment plan was modified after approval was requested (hash mismatch).',
        };
      }
    }

    if (durableApproval) {
      await db
        .update(schema.pendingApprovals)
        .set({ status: 'approved' })
        .where(eq(schema.pendingApprovals.id, promptId));
    }

    // Handle pre-deployment configuration and tool approval
    if (action === 'DEPLOY_CONFIRM') {
      const { deploymentId, projectId, plan } = details;

      if (options?.enableAutoMode) {
        await settingsService.setAccessMode('AUTO');
      }

      // Store user-entered variables into Vault and bind to project
      if (options?.variables) {
        for (const [key, val] of Object.entries(options.variables)) {
          if (val && val.trim()) {
            const cred = await vaultService.createCredential({
              keyName: key,
              plaintextValue: val.trim(),
              description: `Configured via AI Chat for project ${projectId}`,
              scope: 'PROJECT_SCOPED',
            });
            await vaultService.bindCredentialToProject({
              projectId,
              targetEnvVar: key,
              vaultCredentialId: cred.id,
            });
          }
        }
      }

      const variableDecisions = plan.environmentVariables.map((v: any) => {
        const userProvided = options?.variables?.[v.key];
        if (userProvided && userProvided.trim()) {
          return {
            key: v.key,
            action: 'create_new',
            newValue: userProvided.trim(),
          };
        }
        return {
          key: v.key,
          action: v.matchingVaultCredentialId ? 'use_existing' : 'create_new',
          vaultCredentialId: v.matchingVaultCredentialId,
          newValue: v.defaultValue || '',
        };
      });

      deploymentOrchestrator
        .executeDeployment({
          deploymentId,
          variableDecisions,
        })
        .catch((err: any) => {
          console.error('[ChatService] Background deployment error:', err?.message || err);
        });

      return {
        success: true,
        message: `🚀 Deployment approved! Starting autonomous build and ingress for ${plan.projectName}...`,
        deploymentStream: {
          deploymentId,
          repoUrl: target,
          subdomain: plan.suggestedSubdomain,
        },
      };
    }

    // Execute approved destructive action (DELETE_PROJECT)
    if (action === 'DELETE_PROJECT') {
      const targetName = target.toLowerCase();
      const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.slug, targetName));

      if (proj) {
        const servs = await db.select().from(schema.services).where(eq(schema.services.projectId, proj.id));
        for (const s of servs) {
          if (s.containerId && !s.containerId.startsWith('pid_')) {
            await dockerService.stopAndRemove(s.containerId).catch(() => {});
          }
          await proxyService.removeServiceRoute(s.id).catch(() => {});
        }

        await db.delete(schema.projects).where(eq(schema.projects.id, proj.id));
        return {
          success: true,
          message: `Project "${proj.name}" and all associated containers, routes, and records were successfully deleted.`,
        };
      }
    }

    return { success: true, message: `Approved action "${action}" completed successfully.` };
  }
}

export const aiChatService = new AIChatService();
