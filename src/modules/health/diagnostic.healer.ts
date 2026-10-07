import { dockerService } from '../docker/docker.service.js';
import { proxyService } from '../proxy/proxy.service.js';
import { vaultService } from '../vault/vault.service.js';
import { eventBus } from '../../core/events.js';

export interface AutoHealResult {
  remediated: boolean;
  actionTaken?: string;
  newPort?: number;
}

export class DiagnosticHealer {
  // Autonomously inspects container logs to detect crashes and automatically fixes them
  async diagnoseAndRemediate(params: {
    deploymentId: string;
    projectId: string;
    serviceId: string;
    containerName: string;
    hostname: string;
    configuredPort: number;
    migrationCommand?: string;
  }): Promise<AutoHealResult> {
    const logs = await dockerService.getContainerLogs(params.containerName, 100);

    // 1. Check for missing database migrations
    if (
      logs.includes('relation') && logs.includes('does not exist') ||
      logs.includes('table') && logs.includes('does not exist') ||
      logs.includes('no such table') ||
      logs.includes('P2021') // Prisma missing table code
    ) {
      if (params.migrationCommand) {
        eventBus.emitLog({
          deploymentId: params.deploymentId,
          timestamp: Date.now(),
          level: 'warn',
          stage: 'auto_heal',
          message: `[Auto-Healer] Detected unapplied database migrations. Running: ${params.migrationCommand}`,
        });

        const cmd = params.migrationCommand.split(' ');
        await dockerService.execCommand(params.containerName, cmd);
        return {
          remediated: true,
          actionTaken: `Executed database migration (${params.migrationCommand})`,
        };
      }
    }

    // 2. Check for port mismatch (e.g., app listens on 8080/5000/4000 instead of configured port)
    const portMatch = logs.match(/(?:listening on|running on|started on|port)\s*(?:port\s*)?:?(\d{4,5})/i);
    if (portMatch) {
      const detectedPort = parseInt(portMatch[1], 10);
      if (detectedPort !== params.configuredPort && detectedPort > 1024) {
        eventBus.emitLog({
          deploymentId: params.deploymentId,
          timestamp: Date.now(),
          level: 'warn',
          stage: 'auto_heal',
          message: `[Auto-Healer] Detected actual listening port mismatch (${detectedPort} vs configured ${params.configuredPort}). Updating reverse proxy route autonomously...`,
        });

        // Update reverse proxy route to the newly detected port
        await proxyService.registerServiceRoute({
          serviceId: params.serviceId,
          hostname: params.hostname,
          targetUpstream: `${params.containerName}:${detectedPort}`,
        });

        return {
          remediated: true,
          actionTaken: `Reconfigured proxy upstream from :${params.configuredPort} to :${detectedPort}`,
          newPort: detectedPort,
        };
      }
    }

    // 3. Check for missing environment variable crash
    const missingVarMatch = logs.match(/(?:Missing required environment variable|KeyError:)\s*["']?([A-Z0-9_]+)["']?/i);
    if (missingVarMatch) {
      const missingKey = missingVarMatch[1];
      const fallbackValue = vaultService.generateRandomSecret('hex32');

      eventBus.emitLog({
        deploymentId: params.deploymentId,
        timestamp: Date.now(),
        level: 'warn',
        stage: 'auto_heal',
        message: `[Auto-Healer] Detected missing runtime environment variable "${missingKey}". Synthesizing secure fallback and injecting into container...`,
      });

      const cred = await vaultService.createCredential({
        keyName: missingKey,
        plaintextValue: fallbackValue,
        description: `Auto-healed synthesized secret for ${missingKey}`,
        scope: 'PROJECT_SCOPED',
        owningProjectId: params.projectId,
        isSystemGenerated: true,
      });

      await vaultService.bindCredentialToProject({
        projectId: params.projectId,
        targetEnvVar: missingKey,
        vaultCredentialId: cred.id,
      });

      return {
        remediated: true,
        actionTaken: `Synthesized and injected missing required secret "${missingKey}"`,
      };
    }

    return { remediated: false };
  }
}

export const diagnosticHealer = new DiagnosticHealer();
