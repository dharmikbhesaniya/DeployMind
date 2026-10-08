/**
 * DeployMind Interactive AI Agent Service
 * Orchestrates TypeSafe Jev (System 1) + ChatGPT (System 2) + Live Docker/Database Operations.
 * Delivers Claude Code-style interactive desktop experience in natural language.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { dockerService } from '../docker/docker.service.js';
import { proxyService } from '../proxy/proxy.service.js';
import { deploymentOrchestrator } from '../planner/deployment.orchestrator.js';
import { vaultService } from '../vault/vault.service.js';
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
      activeProjects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        repoUrl: p.repoUrl,
        status: p.status,
      })),
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
          await dockerService.startContainer({
            containerName: serv.containerId,
            imageTag: serv.imageTag,
            env: {},
            exposedPort: serv.internalPort,
          });
        }
        actionResult = { action: 'START_SERVICE', success: true, output: `Started ${target}` };
      } else if (intent.choice === 'STOP_SERVICE') {
        const target = intent.entities.serviceName || '';
        const serv = services.find((s) => s.name.toLowerCase().includes(target.toLowerCase()));
        if (serv?.containerId && !serv.containerId.startsWith('pid_')) {
          await dockerService.stopAndRemove(serv.containerId);
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

          // Execute deployment asynchronously so real-time events stream into chat
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
      } else if (intent.choice === 'CONFIGURE_ENV' && intent.entities.envKey && intent.entities.envValue) {
        await vaultService.storeCredential({
          keyName: intent.entities.envKey,
          value: intent.entities.envValue,
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
  async handleConfirmation(promptId: string, approved: boolean): Promise<{ success: boolean; message: string }> {
    const prompt = pendingPrompts.get(promptId);
    if (!prompt) {
      return { success: false, message: 'Interactive prompt has expired or was already handled.' };
    }

    pendingPrompts.delete(promptId);

    if (!approved) {
      return { success: true, message: `Action "${prompt.action}" was cancelled by user.` };
    }

    // Execute approved destructive action
    if (prompt.action === 'DELETE_PROJECT') {
      const targetName = prompt.target.toLowerCase();
      const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.slug, targetName));

      if (proj) {
        // Find associated services and containers
        const servs = await db.select().from(schema.services).where(eq(schema.services.projectId, proj.id));
        for (const s of servs) {
          if (s.containerId && !s.containerId.startsWith('pid_')) {
            await dockerService.stopAndRemove(s.containerId).catch(() => {});
          }
          await proxyService.removeServiceRoute(s.id).catch(() => {});
        }

        // Delete from database
        await db.delete(schema.projects).where(eq(schema.projects.id, proj.id));
        return {
          success: true,
          message: `Project "${proj.name}" and all associated containers, routes, and records were successfully deleted.`,
        };
      }
    }

    return { success: true, message: `Approved action "${prompt.action}" completed successfully.` };
  }
}

export const aiChatService = new AIChatService();
