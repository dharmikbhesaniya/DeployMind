import { dockerService } from '../docker/docker.service.js';
import { eventBus } from '../../core/events.js';
import { config } from '../../config/index.js';

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
    const maxRetries = params.maxRetries || config.health.maxRetries;
    const path = params.path || '/';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      eventBus.emitLog({
        deploymentId: params.deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'health_check',
        message: `Health check attempt ${attempt}/${maxRetries}...`,
      });

      // Give process/container a moment to initialize
      await new Promise((r) => setTimeout(r, config.health.retryIntervalMs));

      // 1. Direct HTTP probe
      try {
        const res = await fetch(`http://127.0.0.1:${params.port}${path}`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.status < 500) {
          eventBus.emitLog({
            deploymentId: params.deploymentId,
            timestamp: Date.now(),
            level: 'success',
            stage: 'health_check',
            message: `Application is online and responding (HTTP ${res.status}) on port ${params.port}.`,
          });
          return { healthy: true, statusCode: res.status };
        }
      } catch {
        // HTTP probe not ready yet, check logs
      }

      // 2. Container log probe (if running in Docker)
      if (isDocker && !params.containerName.startsWith('pid_')) {
        try {
          const logs = await dockerService.getContainerLogs(params.containerName, 50);

          // Detect missing database migrations and auto-heal
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
        } catch {
          // Non-fatal Docker log read
        }
      }
    }

    return { healthy: false, error: `Health check timed out after ${maxRetries} attempts on port ${params.port}` };
  }
}

export const healthObserver = new HealthObserver();
