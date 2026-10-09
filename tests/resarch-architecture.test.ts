import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/server/index.js';
import { capacityService } from '../src/modules/system/capacity.service.js';
import { resourceManager } from '../src/modules/resources/resource.manager.js';
import { reconcilerService } from '../src/modules/orchestration/reconciler.service.js';
import { incidentService } from '../src/modules/health/incident.service.js';
import { deploymentOrchestrator } from '../src/modules/planner/deployment.orchestrator.js';
import { db, schema } from '../src/db/index.js';
import { eq } from 'drizzle-orm';

describe('Architectural Integrity & Control Plane Verification (resarch.txt)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Reset test services table so previous test runs do not artificially inflate allocated workload memory
    await db.delete(schema.services);
    app = await createServer();
    await app.ready();
  });

  afterAll(async () => {
    reconcilerService.stop();
    await app.close();
  });

  describe('1. Host Capacity Discovery & Resource Admission Controller', () => {
    it('should discover host hardware metrics with reserved quotas', async () => {
      const metrics = await capacityService.getHostMetrics();

      expect(metrics.totalMemoryMb).toBeGreaterThan(0);
      expect(metrics.osReserveMb).toBe(1536);
      expect(metrics.platformReserveMb).toBe(512);
      expect(metrics.safetyBufferMb).toBe(1024);
      expect(metrics.cpuCores).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(metrics.loadAverage)).toBe(true);
      expect(metrics.diskTotalMb).toBeGreaterThan(0);
    });

    it('should approve admission when application fits within host headroom', async () => {
      const result = await capacityService.evaluateAdmission({
        requiredCpu: 1,
        requiredMemoryMb: 512,
        requiredDiskMb: 500,
      });

      if (!result.allowed) {
        console.error('Admission rejection reasons:', result.reasons);
      }

      expect(result.allowed).toBe(true);
      expect(result.confidence).toBe(1.0);
      expect(result.reasons.some((r) => r.includes('Disk headroom verified'))).toBe(true);
    });

    it('should reject admission when memory requirements drastically exceed capacity', async () => {
      const result = await capacityService.evaluateAdmission({
        requiredCpu: 16,
        requiredMemoryMb: 9999999, // 10 Terabytes of RAM
        requiredDiskMb: 1000,
      });

      expect(result.allowed).toBe(false);
      expect(result.confidence).toBe(0.0);
      expect(result.reasons.some((r) => r.includes('Insufficient RAM'))).toBe(true);
    });
  });

  describe('2. Shared Infrastructure Tenancy & Dependency Guards', () => {
    const testProjId = `test_proj_${Date.now()}`;

    beforeAll(async () => {
      await db.insert(schema.projects).values({
        id: testProjId,
        name: 'Tenancy Test Project',
        slug: `tenancy-slug-${Date.now()}`,
        repoUrl: 'https://github.com/example/tenancy',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    it('should provision and track a PostgreSQL tenant in database', async () => {
      const creds = await resourceManager.provisionPostgresTenant(testProjId);

      expect(creds.connectionUri).toContain('postgresql://');
      expect(creds.databaseName).toBeDefined();
      expect(creds.username).toBeDefined();

      const tenants = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.projectId, testProjId));

      expect(tenants.length).toBeGreaterThanOrEqual(1);
      expect(tenants[0].databaseName).toBe(creds.databaseName);
    });

    it('should guard shared PostgreSQL against deletion when active tenants exist', async () => {
      await expect(resourceManager.deleteSharedPostgres(false)).rejects.toThrow(
        /Safety Violation: Cannot delete shared PostgreSQL/
      );
    });

    it('should deprovision tenant cleanly and release bindings', async () => {
      await resourceManager.deprovisionPostgresTenant(testProjId);

      const tenants = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.projectId, testProjId));

      expect(tenants.length).toBe(0);
    });
  });

  describe('3. Desired-State Reconciliation Loop & Audit Logging', () => {
    it('should execute reconciliation cycle and produce report without errors', async () => {
      const report = await reconcilerService.reconcile();

      expect(report.timestamp).toBeGreaterThan(0);
      expect(typeof report.servicesChecked).toBe('number');
      expect(typeof report.driftRecoveries).toBe('number');
      expect(Array.isArray(report.orphanContainersDetected)).toBe(true);
    });

    it('should record and resolve an incident in SQLite audit trail', async () => {
      const incident = await incidentService.recordIncident({
        symptom: 'Container exited with 137',
        diagnosis: 'Transient memory spike during build',
        riskLevel: 'SAFE',
        actionTaken: 'Restart container',
      });

      expect(incident.id).toBeDefined();
      expect(incident.resolved).toBe(false);

      await incidentService.resolveIncident(incident.id, 'Restart completed and health check passed');

      const [updated] = await db
        .select()
        .from(schema.incidents)
        .where(eq(schema.incidents.id, incident.id));

      expect(updated.resolved).toBe(true);
      expect(updated.resolvedAt).toBeGreaterThan(0);
    });
  });

  describe('4. REST API Endpoints for Control Plane Operations', () => {
    it('GET /api/system/capacity should return host discovery metrics', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/system/capacity',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.totalMemoryMb).toBeGreaterThan(0);
      expect(json.allocatableMemoryMb).toBeDefined();
    });

    it('POST /api/orchestration/reconcile should trigger reconciliation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/orchestration/reconcile',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.timestamp).toBeDefined();
      expect(json.servicesChecked).toBeDefined();
    });

    it('GET /api/audit-logs should return audit trail', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-logs',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(Array.isArray(json)).toBe(true);
    });

    it('GET /api/incidents should return active incidents', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/incidents',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(Array.isArray(json)).toBe(true);
    });
  });

  describe('5. Cascading Safe Project Deletion', () => {
    it('should safely delete project and audit teardown', async () => {
      const projId = `del_test_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: projId,
        name: 'Delete Test Project',
        slug: `del-slug-${Date.now()}`,
        repoUrl: 'https://github.com/example/delete-test',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const res = await deploymentOrchestrator.deleteProject(projId, { deleteData: true });
      expect(res.success).toBe(true);

      const [found] = await db.select().from(schema.projects).where(eq(schema.projects.id, projId));
      expect(found).toBeUndefined();
    });
  });
});
