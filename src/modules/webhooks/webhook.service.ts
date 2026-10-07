import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { deploymentOrchestrator } from '../planner/deployment.orchestrator.js';

export class WebhookService {
  // Handles incoming git webhook (GitHub, GitLab, Gitea) and redeploys autonomously
  async handlePushEvent(projectId: string, payload: any): Promise<{ triggered: boolean; deploymentId?: string }> {
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const branch = payload?.ref ? payload.ref.replace('refs/heads/', '') : 'main';

    if (project.branch && branch !== project.branch) {
      return { triggered: false };
    }

    // Trigger autonomous 1-click re-deployment
    const { deploymentId, plan } = await deploymentOrchestrator.analyzeAndPlan(
      project.repoUrl,
      project.name
    );

    // Auto-execute with existing or auto-generated decisions
    await deploymentOrchestrator.executeDeployment({
      deploymentId,
      variableDecisions: plan.environmentVariables.map((v) => ({
        key: v.key,
        action: v.matchingVaultCredentialId ? 'use_existing' : 'auto_generate',
        vaultCredentialId: v.matchingVaultCredentialId,
      })),
    });

    return { triggered: true, deploymentId };
  }
}

export const webhookService = new WebhookService();
