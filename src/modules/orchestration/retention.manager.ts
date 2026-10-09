import fs from 'node:fs';
import path from 'node:path';
import { lt } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { config } from '../../config/index.js';

export interface RetentionReport {
  timestamp: number;
  prunedDeploymentLogs: number;
  prunedIncidents: number;
  freedBytesEstimate: number;
}

export class RetentionManager {
  readonly defaultLogRetentionDays = 7;

  // Prunes application deployment logs and temporary build artifacts older than 7 days
  async pruneOldArtifacts(retentionDays = this.defaultLogRetentionDays): Promise<RetentionReport> {
    const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let prunedDeploymentLogs = 0;
    let prunedIncidents = 0;
    let freedBytesEstimate = 0;

    // 1. Truncate/purge old deployment logs in SQLite
    try {
      const oldDeployments = await db
        .select()
        .from(schema.deployments)
        .where(lt(schema.deployments.updatedAt, cutoffTimestamp));

      for (const d of oldDeployments) {
        if (d.logs && d.logs.length > 500) {
          freedBytesEstimate += Buffer.byteLength(d.logs, 'utf8');
          await db
            .update(schema.deployments)
            .set({
              logs: `[Log Retention Policy] Truncated after ${retentionDays} days. Status was: ${d.status}`,
            })
            .where(lt(schema.deployments.id, d.id));
          prunedDeploymentLogs++;
        }
      }
    } catch {
      // Non-fatal
    }

    // 2. Clean up resolved incidents older than retention window
    try {
      const oldIncidents = await db
        .select()
        .from(schema.incidents)
        .where(lt(schema.incidents.createdAt, cutoffTimestamp));

      for (const inc of oldIncidents) {
        if (inc.resolved) {
          await db.delete(schema.incidents).where(lt(schema.incidents.id, inc.id));
          prunedIncidents++;
        }
      }
    } catch {
      // Non-fatal
    }

    // 3. Clean temporary repo clone checkouts
    try {
      const reposDir = path.join(config.dataDir, 'repos');
      if (fs.existsSync(reposDir)) {
        const entries = fs.readdirSync(reposDir);
        for (const entry of entries) {
          const entryPath = path.join(reposDir, entry);
          try {
            const stat = fs.statSync(entryPath);
            if (stat.mtimeMs < cutoffTimestamp) {
              const size = this.getDirectorySize(entryPath);
              fs.rmSync(entryPath, { recursive: true, force: true });
              freedBytesEstimate += size;
            }
          } catch {
            // Skip in-use directories
          }
        }
      }
    } catch {
      // Non-fatal
    }

    // Record audit event
    await db.insert(schema.auditLogs).values({
      id: `aud_${crypto.randomUUID()}`,
      eventType: 'retention_prune',
      details: JSON.stringify({
        retentionDays,
        prunedDeploymentLogs,
        prunedIncidents,
        freedBytesEstimate,
      }),
      timestamp: Date.now(),
    });

    return {
      timestamp: Date.now(),
      prunedDeploymentLogs,
      prunedIncidents,
      freedBytesEstimate,
    };
  }

  private getDirectorySize(dirPath: string): number {
    let total = 0;
    try {
      const files = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const file of files) {
        const fullPath = path.join(dirPath, file.name);
        if (file.isDirectory()) {
          total += this.getDirectorySize(fullPath);
        } else {
          total += fs.statSync(fullPath).size;
        }
      }
    } catch {
      // Ignore
    }
    return total;
  }
}

export const retentionManager = new RetentionManager();
