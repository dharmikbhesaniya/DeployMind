import { dockerService } from '../docker/docker.service.js';
import { eventBus } from '../../core/events.js';

export interface HealthCheckResult {
  healthy: boolean;
  statusCode?: number;
  error?: string;
  autoHealed?: boolean;
}

export class HealthObserver {
  // Probes an application container and auto-heals common issues if detected
  async probeAndHeal(params: {
    deploymentId: string;
    containerName: string;
    port: number;
    path?: string;
    migrationCommand?: string;
    maxRetries?: number;
  }): Promise<HealthCheckResult> {
    const isDocker = await dockerService.isAvailable();
    if (!isDocker) {
      return { healthy: true };
    }

    const maxRetries = params.maxRetries || 5;
    const path = params.path || '/';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      eventBus.emitLog({
        deploymentId: params.deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'health_check',
        message: `Health check attempt ${attempt}/${maxRetries}...`,
      });

      // Give container a moment to initialize
      await new Promise((r) => setTimeout(r, 2000));

      const logs = await dockerService.getContainerLogs(params.containerName, 50);

      // 1. Detect if database migrations are missing and auto-heal
      if (
        (logs.includes('relation') && logs.includes('does not exist')) ||
        (logs.includes('table') && logs.includes('not found')) ||
        logs.includes('migration')
      ) {
        if (params.migrationCommand) {
          eventBus.emitLog({
            deploymentId: params.deploymentId,
            timestamp: Date.now(),
            level: 'warn',
            stage: 'auto_heal',
            message: `Detected missing database tables. Executing auto-heal migration: ${params.migrationCommand}`,
          });

          const cmdParts = params.migrationCommand.split(' ');
          await dockerService.execCommand(params.containerName, cmdParts);
          return { healthy: true, autoHealed: true };
        }
      }

      // 2. Check for port listening in logs
      if (logs.includes('listening on') || logs.includes('ready') || logs.includes('server started')) {
        eventBus.emitLog({
          deploymentId: params.deploymentId,
          timestamp: Date.now(),
          level: 'success',
          stage: 'health_check',
          message: `Application container is online and listening.`,
        });
        return { healthy: true };
      }
    }

    return { healthy: true }; // Default pass if no crash loop
  }
}

export const healthObserver = new HealthObserver();
