import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { dockerService } from '../src/modules/docker/docker.service.js';
import { resourceManager } from '../src/modules/resources/resource.manager.js';
import { deploymentOrchestrator } from '../src/modules/planner/deployment.orchestrator.js';
import { db, schema } from '../src/db/index.js';
import { eq } from 'drizzle-orm';
import type { DeploymentPlan } from '../src/core/types.js';

describe('Docker Volumes and Inter-Service Network Architecture', () => {
  const testProjectId = `test_vol_net_${Date.now()}`;

  beforeAll(async () => {
    await db.insert(schema.projects).values({
      id: testProjectId,
      name: 'Docker Volume & Network Test Project',
      slug: `vol-net-slug-${Date.now()}`,
      repoUrl: 'https://github.com/example/db-app',
      branch: 'main',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  afterAll(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, testProjectId));
  });

  describe('1. Docker Volume Lifecycle Management', () => {
    it('should create and verify a managed Docker volume', async () => {
      const volName = `test_vol_${Date.now()}`;
      const ensured = await dockerService.ensureVolume(volName, {
        'deploymind.project_id': testProjectId,
      });

      expect(ensured).toBe(volName);

      // Verify listing with project filter
      const vols = await dockerService.listVolumes(testProjectId);
      const found = vols.find((v) => v.name === volName);
      expect(found).toBeDefined();
      expect(found?.labels['deploymind.project_id']).toBe(testProjectId);

      // Remove volume
      const removed = await dockerService.removeVolume(volName);
      expect(removed).toBe(true);

      const volsAfter = await dockerService.listVolumes(testProjectId);
      expect(volsAfter.find((v) => v.name === volName)).toBeUndefined();
    });
  });

  describe('2. Inter-Service Network & Backing Services Wiring', () => {
    it('should auto-provision PostgreSQL tenant and wire DATABASE_URL to shared postgres on deploymind-net', async () => {
      const mockPlan: DeploymentPlan = {
        projectName: 'db-connected-app',
        framework: 'express',
        runtime: 'node',
        buildType: 'dockerfile',
        exposedPort: 3000,
        healthCheckPath: '/',
        suggestedSubdomain: 'db-app.localhost',
        environmentVariables: [
          {
            key: 'DATABASE_URL',
            description: 'Connection string for PostgreSQL',
            required: true,
          },
        ],
        requiredBackingServices: [
          {
            serviceType: 'postgres',
            strategy: 'reuse_shared',
            reason: 'Needs relational persistence',
          },
        ],
        volumes: [
          {
            hostVolumeName: `vol_${testProjectId}_uploads`,
            containerPath: '/app/uploads',
          },
        ],
        securityRisks: [],
        confidenceScore: 0.95,
        evidenceExplanation: [],
      };

      // Create deployment record
      const depId = `dep_vol_${Date.now()}`;
      await db.insert(schema.deployments).values({
        id: depId,
        projectId: testProjectId,
        status: 'analyzing',
        rawManifest: JSON.stringify({}),
        deploymentPlan: JSON.stringify(mockPlan),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Execute deployment
      await deploymentOrchestrator.executeDeployment({
        deploymentId: depId,
        variableDecisions: [],
      });

      // Verify PostgreSQL tenant was provisioned in database
      const tenants = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.projectId, testProjectId));

      expect(tenants.length).toBeGreaterThanOrEqual(1);
      const pgTenant = tenants.find((t) => t.databaseName?.startsWith('db_'));
      expect(pgTenant).toBeDefined();

      // Verify credentials point to deploymind-shared-postgres on deploymind-net
      const parsedCreds = JSON.parse(pgTenant!.encryptedCredentials);
      expect(parsedCreds.connectionUri).toContain('deploymind-shared-postgres:5432');
    });

    it('should clean up volumes and deprovision tenant on project deletion when deleteData=true', async () => {
      const testVolName = `vol_${testProjectId.replace(/[^a-zA-Z0-9]/g, '_')}_data`;
      await dockerService.ensureVolume(testVolName, {
        'deploymind.project_id': testProjectId,
      });

      const delRes = await deploymentOrchestrator.deleteProject(testProjectId, {
        deleteData: true,
      });

      expect(delRes.success).toBe(true);
      expect(delRes.freedResources.some((r) => r.includes('PostgreSQL'))).toBe(true);

      // Verify tenant is deprovisioned
      const tenants = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.projectId, testProjectId));
      expect(tenants.length).toBe(0);
    });
  });
});
