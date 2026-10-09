import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { dockerService } from '../docker/docker.service.js';
import { proxyService } from '../proxy/proxy.service.js';
import { lockManager } from '../../core/lock.manager.js';
import { retentionManager } from './retention.manager.js';

export interface ReconciliationReport {
  timestamp: number;
  servicesChecked: number;
  driftRecoveries: number;
  routesReconciled: number;
  orphanContainersDetected: string[];
}

export class ReconcilerService {
  private intervalTimer: NodeJS.Timeout | null = null;
  private isReconciling = false;
  private lastRetentionPruneTime = 0;

  // Starts continuous desired-state reconciliation loop
  start(intervalMs = 30000): void {
    if (this.intervalTimer) return;
    console.log(`🔄 [Reconciler] State engine background loop active (Interval: ${intervalMs}ms)`);
    this.intervalTimer = setInterval(() => {
      this.reconcile().catch((err) => {
        console.warn('[Reconciler] Error during reconciliation cycle:', err?.message || err);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  // Single reconciliation execution cycle
  async reconcile(): Promise<ReconciliationReport> {
    if (this.isReconciling) {
      return {
        timestamp: Date.now(),
        servicesChecked: 0,
        driftRecoveries: 0,
        routesReconciled: 0,
        orphanContainersDetected: [],
      };
    }

    this.isReconciling = true;
    let servicesChecked = 0;
    let driftRecoveries = 0;
    let routesReconciled = 0;
    const orphanContainers: string[] = [];

    try {
      const isDockerReady = await dockerService.isAvailable();
      const allServices = await db.select().from(schema.services);
      servicesChecked = allServices.length;

      // 1. Reconcile container runtimes vs desired state
      if (isDockerReady) {
        for (const s of allServices) {
          if (!s.containerId || s.containerId.startsWith('pid_')) continue;

          // Skip reconciling services belonging to a project currently undergoing active deployment
          if (lockManager.isLocked(s.projectId)) {
            continue;
          }

          const isRunning = await dockerService.isContainerRunning(s.containerId);

          if (s.desiredState === 'running' && !isRunning) {
            console.warn(`[Reconciler] Drift detected: Service "${s.name}" (${s.id}) is stopped. Recovering...`);
            driftRecoveries++;

            // Attempt container restart to align reality with desired state
            try {
              const container = (dockerService as any).docker.getContainer(s.containerId);
              await container.start();
              await db
                .update(schema.services)
                .set({ actualState: 'running', updatedAt: Date.now() })
                .where(eq(schema.services.id, s.id));

              // Record audit log
              await db.insert(schema.auditLogs).values({
                id: `aud_${crypto.randomUUID()}`,
                eventType: 'reconciliation_recovery',
                projectId: s.projectId,
                serviceId: s.id,
                details: JSON.stringify({
                  action: 'restart_container',
                  containerId: s.containerId,
                  reason: 'runtime_drift',
                }),
                timestamp: Date.now(),
              });
            } catch (restartErr: any) {
              await db
                .update(schema.services)
                .set({ actualState: 'degraded', updatedAt: Date.now() })
                .where(eq(schema.services.id, s.id));
            }
          } else if (s.desiredState === 'stopped' && isRunning) {
            console.warn(`[Reconciler] Stopping container for stopped service "${s.name}"`);
            await dockerService.stopContainer(s.containerId);
            await db
              .update(schema.services)
              .set({ actualState: 'stopped', updatedAt: Date.now() })
              .where(eq(schema.services.id, s.id));
          } else if (s.desiredState === 'running' && isRunning && s.actualState !== 'running') {
            await db
              .update(schema.services)
              .set({ actualState: 'running', updatedAt: Date.now() })
              .where(eq(schema.services.id, s.id));
          }
        }

        // 2. Detect orphan containers (tagged deploymind.managed but unknown to DB)
        const managedContainers = await dockerService.listManagedContainers();
        const activeContainerIds = new Set(allServices.map((s) => s.containerId).filter(Boolean));

        for (const c of managedContainers) {
          const cId = c.Id;
          const resourceType = c.Labels?.['deploymind.resource_type'];

          // Skip shared postgres/redis system resources
          if (resourceType === 'shared_postgres' || resourceType === 'shared_redis') continue;

          const isKnown = activeContainerIds.has(cId) || Array.from(activeContainerIds).some((id) => id && cId.startsWith(id));
          if (!isKnown) {
            orphanContainers.push(cId);
            console.info(`[Reconciler] Quarantine Notice: Orphan managed container detected: ${c.Names?.[0] || cId}`);
          }
        }
      }

      // 3. Reconcile reverse proxy routes
      try {
        await proxyService.syncDatabaseRoutes();
        routesReconciled = (await db.select().from(schema.domains)).length;
      } catch {
        // Non-fatal
      }

      // 4. Automated log & artifact retention pruning (runs every 24 hours)
      if (Date.now() - this.lastRetentionPruneTime > 24 * 60 * 60 * 1000) {
        this.lastRetentionPruneTime = Date.now();
        await retentionManager.pruneOldArtifacts(7).catch(() => {});
      }
    } finally {
      this.isReconciling = false;
    }

    return {
      timestamp: Date.now(),
      servicesChecked,
      driftRecoveries,
      routesReconciled,
      orphanContainersDetected: orphanContainers,
    };
  }
}

export const reconcilerService = new ReconcilerService();
