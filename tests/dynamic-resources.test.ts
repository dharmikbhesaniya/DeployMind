import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { resourceRegistry } from '../src/modules/resources/resource.registry.js';
import { resourcePlanner } from '../src/modules/resources/resource.planner.js';
import { resourceManager } from '../src/modules/resources/resource.manager.js';
import { createServer } from '../src/server/index.js';

describe('Dynamic Backing Services & Intelligent Shared Infrastructure Architecture (issue.txt)', () => {
  describe('1. Dynamic Resource Registry & Adapter Extensibility', () => {
    it('should support dynamic pluggable adapters and normalize aliases', () => {
      const types = resourceRegistry.listSupportedTypes();
      expect(types).toContain('postgres');
      expect(types).toContain('redis');
      expect(types).toContain('mysql');
      expect(types).toContain('mongodb');
      expect(types).toContain('rabbitmq');
      expect(types).toContain('minio');

      // Test alias normalization
      expect(resourceRegistry.normalizeType('mariadb')).toBe('mysql');
      expect(resourceRegistry.normalizeType('mongo')).toBe('mongodb');
      expect(resourceRegistry.normalizeType('amqp')).toBe('rabbitmq');
      expect(resourceRegistry.normalizeType('s3')).toBe('minio');
      expect(resourceRegistry.normalizeType('postgresql')).toBe('postgres');
    });

    it('should reject unsupported backing services safely without inventing hallucinated plans', async () => {
      const decision = await resourcePlanner.evaluateRequirement({
        type: 'unsupported_custom_db_xyz',
      });
      expect(decision.decision.action).toBe('reject');
      expect(decision.reasoning).toContain('Unsupported backing service');
    });
  });

  describe('2. Deterministic Resource Planner (Policy Engine: Reuse vs Provision)', () => {
    it('should plan provisioning when no shared instance exists, and reuse once provisioned', async () => {
      // Ensure clean state for mysql
      await db.delete(schema.sharedResources).where(eq(schema.sharedResources.resourceType, 'mysql'));

      const projA = `proj_app_a_${Date.now()}`;
      const projB = `proj_app_b_${Date.now()}`;

      await db.insert(schema.projects).values([
        {
          id: projA,
          name: 'App A',
          slug: `app-a-${Date.now()}`,
          repoUrl: 'https://github.com/example/app-a',
          branch: 'main',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: projB,
          name: 'App B',
          slug: `app-b-${Date.now()}`,
          repoUrl: 'https://github.com/example/app-b',
          branch: 'main',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

      // Step 1: App A plans MySQL
      const evalA = await resourcePlanner.evaluateRequirement({
        type: 'mysql',
        isolationLevel: 'standard',
      });
      expect(evalA.decision.action).toBe('provision');

      // Execute provisioning for App A
      const execA = await resourcePlanner.executeDecision({
        decision: evalA.decision,
        projectId: projA,
        requirement: { type: 'mysql' },
      });
      expect(execA.reused).toBe(false);
      expect(execA.binding.credentials.MYSQL_URL).toBeDefined();

      // Step 2: App B plans MySQL -> Planner must REUSE App A's shared MySQL container!
      const evalB = await resourcePlanner.evaluateRequirement({
        type: 'mysql',
        isolationLevel: 'standard',
      });
      expect(evalB.decision.action).toBe('reuse');
      if (evalB.decision.action === 'reuse') {
        expect(evalB.decision.resourceId).toBe(execA.resourceId);
      }

      // Execute binding for App B
      const execB = await resourcePlanner.executeDecision({
        decision: evalB.decision,
        projectId: projB,
        requirement: { type: 'mysql' },
      });
      expect(execB.reused).toBe(true);
      expect(execB.resourceId).toBe(execA.resourceId);

      // Verify App A and App B have distinct isolated databases on the SAME container
      expect(execA.binding.databaseName).not.toBe(execB.binding.databaseName);
      expect(execA.binding.credentials.MYSQL_DATABASE).toContain(`db_${projA.toLowerCase()}`);
      expect(execB.binding.credentials.MYSQL_DATABASE).toContain(`db_${projB.toLowerCase()}`);
    });

    it('should respect dedicated container isolation requirement when explicitly requested', async () => {
      const evalDedicated = await resourcePlanner.evaluateRequirement({
        type: 'postgres',
        isolationLevel: 'dedicated',
      });
      expect(evalDedicated.decision.action).toBe('provision');
      expect(evalDedicated.reasoning).toContain('Dedicated isolation requested');
    });
  });

  describe('3. Dynamic Backing Services (MongoDB, RabbitMQ, MinIO S3)', () => {
    it('should dynamically provision and bind MongoDB document database', async () => {
      const projId = `proj_mongo_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: projId,
        name: 'Mongo App',
        slug: `mongo-app-${Date.now()}`,
        repoUrl: 'https://github.com/example/mongo-app',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const binding = await resourceManager.provisionTenant(projId, { type: 'mongodb' });
      expect(binding.credentials.MONGODB_URI).toContain('mongodb://');
      expect(binding.credentials.MONGO_HOST).toBe('deploymind-shared-mongo');
    });

    it('should dynamically provision and bind RabbitMQ message broker', async () => {
      const projId = `proj_rb_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: projId,
        name: 'Rabbit App',
        slug: `rabbit-app-${Date.now()}`,
        repoUrl: 'https://github.com/example/rabbit-app',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const binding = await resourceManager.provisionTenant(projId, { type: 'rabbitmq' });
      expect(binding.credentials.AMQP_URL).toContain('amqp://');
      expect(binding.credentials.RABBITMQ_HOST).toBe('deploymind-shared-rabbitmq');
      expect(binding.credentials.RABBITMQ_VHOST).toContain(`vhost_${projId.toLowerCase()}`);
    });

    it('should dynamically provision and bind MinIO S3 object storage', async () => {
      const projId = `proj_s3_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: projId,
        name: 'S3 App',
        slug: `s3-app-${Date.now()}`,
        repoUrl: 'https://github.com/example/s3-app',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const binding = await resourceManager.provisionTenant(projId, { type: 'minio' });
      expect(binding.credentials.S3_ENDPOINT).toContain('deploymind-shared-minio:9000');
      expect(binding.credentials.S3_BUCKET).toContain(`bucket-${projId.toLowerCase()}`);
      expect(binding.credentials.AWS_ACCESS_KEY_ID).toBeDefined();
    });
  });

  describe('4. Lifecycle & Ownership Model: Dependency Graph & Safe Deletion', () => {
    it('should expose the complete dependency graph of all applications and shared infrastructure', async () => {
      const graph = await resourceManager.getDependencyGraph();
      expect(Array.isArray(graph)).toBe(true);
      expect(graph.length).toBeGreaterThanOrEqual(1);

      const item = graph.find((g) => g.resourceType === 'postgres' || g.resourceType === 'mysql');
      expect(item).toBeDefined();
      expect(item?.containerName).toBeDefined();
    });

    it('should strictly guard shared backing services against accidental deletion when dependents exist', async () => {
      const testProj = `proj_guard_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: testProj,
        name: 'Guard App',
        slug: `guard-app-${Date.now()}`,
        repoUrl: 'https://github.com/example/guard',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Bind tenant to postgres
      await resourceManager.provisionPostgresTenant(testProj);

      // Attempting to delete shared PostgreSQL cluster while tenant is bound must throw!
      await expect(resourceManager.deleteSharedPostgres(false)).rejects.toThrow(
        /Safety Violation: Cannot delete shared PostgreSQL cluster while/
      );

      // Deprovision tenant
      await resourceManager.deprovisionPostgresTenant(testProj);
    });

    it('should expose REST API control-plane routes for dynamic resources', async () => {
      const server = await createServer();

      // 1. GET /api/resources/types
      const resTypes = await server.inject({
        method: 'GET',
        url: '/api/resources/types',
      });
      expect(resTypes.statusCode).toBe(200);
      const typesData = JSON.parse(resTypes.payload);
      expect(typesData.supportedTypes).toContain('postgres');
      expect(typesData.supportedTypes).toContain('rabbitmq');

      // 2. GET /api/resources/dependencies
      const resDep = await server.inject({
        method: 'GET',
        url: '/api/resources/dependencies',
      });
      expect(resDep.statusCode).toBe(200);
      const depData = JSON.parse(resDep.payload);
      expect(Array.isArray(depData.dependencyGraph)).toBe(true);
    });
  });
});
