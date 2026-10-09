import os from 'node:os';
import fs from 'node:fs';
import { db, schema } from '../../db/index.js';

export interface CapacityMetrics {
  totalMemoryMb: number;
  freeMemoryMb: number;
  osReserveMb: number;
  platformReserveMb: number;
  safetyBufferMb: number;
  workloadsAllocatedMb: number;
  allocatableMemoryMb: number;
  cpuCores: number;
  loadAverage: number[];
  diskTotalMb: number;
  diskFreeMb: number;
  diskHeadroomSafe: boolean;
}

export interface AdmissionResult {
  allowed: boolean;
  confidence: number;
  metrics: CapacityMetrics;
  reasons: string[];
}

export class CapacityService {
  // Configurable reserves
  readonly osReserveMb = 1536; // 1.5 GB OS operating reserve
  readonly platformReserveMb = 512; // 512 MB DeployMind reserve
  readonly safetyBufferMb = 1024; // 1 GB transient burst buffer
  readonly minFreeDiskMb = 2048; // Minimum 2GB free disk buffer

  // Inspect host machine hardware capacity
  async getHostMetrics(): Promise<CapacityMetrics> {
    const totalMem = Math.floor(os.totalmem() / (1024 * 1024));
    const freeMem = Math.floor(os.freemem() / (1024 * 1024));
    const cpuCores = os.cpus().length || 1;
    const loadAvg = os.loadavg();

    // Calculate memory currently reserved by active services in database
    let workloadsAllocatedMb = 0;
    try {
      const activeServices = await db.select().from(schema.services);
      for (const s of activeServices) {
        if (s.desiredState === 'running' && s.resourceLimits) {
          try {
            const parsed = JSON.parse(s.resourceLimits);
            workloadsAllocatedMb += parsed.memoryMb || 512;
          } catch {
            workloadsAllocatedMb += 512;
          }
        }
      }
    } catch {
      // Non-fatal if DB is initializing
    }

    // Disk space detection using statfsSync if supported
    let diskTotalMb = 50000;
    let diskFreeMb = 25000;
    try {
      if (typeof fs.statfsSync === 'function') {
        const stats = fs.statfsSync('/');
        diskTotalMb = Math.floor((stats.blocks * stats.bsize) / (1024 * 1024));
        diskFreeMb = Math.floor((stats.bfree * stats.bsize) / (1024 * 1024));
      }
    } catch {
      // Fallback defaults
    }

    const allocatable = Math.max(
      0,
      totalMem - this.osReserveMb - this.platformReserveMb - this.safetyBufferMb - workloadsAllocatedMb
    );

    return {
      totalMemoryMb: totalMem,
      freeMemoryMb: freeMem,
      osReserveMb: this.osReserveMb,
      platformReserveMb: this.platformReserveMb,
      safetyBufferMb: this.safetyBufferMb,
      workloadsAllocatedMb,
      allocatableMemoryMb: allocatable,
      cpuCores,
      loadAverage: loadAvg,
      diskTotalMb,
      diskFreeMb,
      diskHeadroomSafe: diskFreeMb >= this.minFreeDiskMb,
    };
  }

  // Evaluate if new application workload can be safely admitted on the VPS
  async evaluateAdmission(requirements: {
    requiredCpu?: number;
    requiredMemoryMb?: number;
    requiredDiskMb?: number;
  }): Promise<AdmissionResult> {
    const metrics = await this.getHostMetrics();
    const reqMem = requirements.requiredMemoryMb || 1024;
    const reqDisk = requirements.requiredDiskMb || 1024;
    const reasons: string[] = [];
    let allowed = true;

    // Check disk headroom
    if (metrics.diskFreeMb < this.minFreeDiskMb + reqDisk) {
      allowed = false;
      reasons.push(
        `Insufficient disk space: Host has ${metrics.diskFreeMb}MB free, but safe threshold requires at least ${
          this.minFreeDiskMb + reqDisk
        }MB.`
      );
    } else {
      reasons.push(`Disk headroom verified: ${metrics.diskFreeMb}MB free (safe threshold met).`);
    }

    // Check memory capacity
    if (metrics.allocatableMemoryMb < reqMem) {
      // If allocatable formula is tight, check physical OS free memory with grace
      if (metrics.freeMemoryMb < reqMem + 512) {
        allowed = false;
        reasons.push(
          `Insufficient RAM: Host allocatable RAM is ${metrics.allocatableMemoryMb}MB (Physical free: ${metrics.freeMemoryMb}MB), but workload requires ${reqMem}MB.`
        );
      } else {
        reasons.push(
          `Allocatable RAM warning: Calculated quota (${metrics.allocatableMemoryMb}MB) is lower than requested (${reqMem}MB), but physical free RAM (${metrics.freeMemoryMb}MB) permits burst admission.`
        );
      }
    } else {
      reasons.push(
        `RAM capacity verified: ${metrics.allocatableMemoryMb}MB allocatable (Workload requires ${reqMem}MB).`
      );
    }

    // Check CPU load average
    if (metrics.loadAverage[0] > metrics.cpuCores * 2) {
      reasons.push(
        `High CPU load detected: 1-min load average is ${metrics.loadAverage[0].toFixed(2)} on ${metrics.cpuCores} cores.`
      );
    } else {
      reasons.push(`CPU capacity verified: ${metrics.cpuCores} core(s) available.`);
    }

    const confidence = allowed ? 1.0 : 0.0;
    return {
      allowed,
      confidence,
      metrics,
      reasons,
    };
  }
}

export const capacityService = new CapacityService();
