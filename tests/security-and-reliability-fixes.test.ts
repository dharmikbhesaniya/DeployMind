import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { buildSanitizedWorkloadEnv } from '../src/core/workload-env.js';
import { getAdminToken, verifyAdminToken } from '../src/core/auth.js';
import { resourceManager } from '../src/modules/resources/resource.manager.js';
import { aiChatService } from '../src/modules/ai/chat.service.js';
import { retentionManager } from '../src/modules/orchestration/retention.manager.js';
import { createServer } from '../src/server/index.js';

describe('Security, Reliability, and Architectural Hardening Fixes', () => {
  beforeEach(async () => {
    await db.delete(schema.pendingApprovals);
  });

  describe('Issue 1: Control Plane Authentication & CORS Hardening', () => {
    it('should generate and verify administrative token with constant-time comparison', () => {
      const token = getAdminToken();
      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(16);
      expect(verifyAdminToken(token)).toBe(true);
      expect(verifyAdminToken('invalid-token')).toBe(false);
      expect(verifyAdminToken('')).toBe(false);
      expect(verifyAdminToken(null)).toBe(false);
    });

    it('should block unauthenticated control plane requests with 401 when auth is enforced', async () => {
      const server = await createServer();
      const token = getAdminToken();

      // Enforced request without token -> 401
      const resBlocked = await server.inject({
        method: 'GET',
        url: '/api/settings',
        headers: {
          'x-test-enforce-auth': 'true',
        },
      });
      expect(resBlocked.statusCode).toBe(401);
      expect(JSON.parse(resBlocked.payload).error).toBe('Unauthorized');

      // Request with valid Bearer token -> 200
      const resAllowed = await server.inject({
        method: 'GET',
        url: '/api/settings',
        headers: {
          'x-test-enforce-auth': 'true',
          authorization: `Bearer ${token}`,
        },
      });
      expect(resAllowed.statusCode).toBe(200);

      // Public health endpoint exempt -> 200
      const resHealth = await server.inject({
        method: 'GET',
        url: '/health',
        headers: {
          'x-test-enforce-auth': 'true',
        },
      });
      expect(resHealth.statusCode).toBe(200);
    });
  });

  describe('Issue 2: Workload Environment Isolation & Secret Leakage Prevention', () => {
    it('should strip DeployMind host secrets and provide a sanitized execution environment', () => {
      // Mock host process.env secrets
      process.env.OPENAI_API_KEY = 'sk-deploymind-host-secret-12345';
      process.env.DEPLOYMIND_ADMIN_TOKEN = 'secret-admin-token-xyz';

      const sanitized = buildSanitizedWorkloadEnv({
        CUSTOM_APP_VAR: 'hello-world',
        OPENAI_API_KEY: 'sk-deploymind-host-secret-12345', // Attempted leak from repo or untrusted config
      });

      // Crucial: DeployMind host secrets must NOT exist in the workload environment
      expect(sanitized.DEPLOYMIND_ADMIN_TOKEN).toBeUndefined();
      expect(sanitized.OPENAI_API_KEY).toBeUndefined();

      // Safe whitelisted system parameters and user config must be preserved
      expect(sanitized.CUSTOM_APP_VAR).toBe('hello-world');
      expect(sanitized.NODE_ENV).toBe('production');
      expect(sanitized.CI).toBe('true');
      expect(sanitized.PATH).toBeDefined();
      expect(sanitized.PATH).toContain('/usr/bin');
    });
  });

  describe('Issue 3 & 4: Shared PostgreSQL & Redis Tenant Security', () => {
    it('should use non-hardcoded dynamic admin passwords for PostgreSQL and Redis', async () => {
      const pgPass1 = await resourceManager.getPostgresAdminPassword();
      const rdPass1 = await resourceManager.getRedisAdminPassword();

      expect(pgPass1).toBeDefined();
      expect(pgPass1).not.toBe('deploymind_secure_pass'); // Verified: Hardcoded password eliminated!

      expect(rdPass1).toBeDefined();
      expect(rdPass1.length).toBeGreaterThan(10);
    });

    it('should assign a per-project key prefix constraint for Redis tenants', async () => {
      const testProjId = `proj_sec_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: testProjId,
        name: 'Redis Sec Project',
        slug: `redis-sec-${Date.now()}`,
        repoUrl: 'https://github.com/example/redis-sec',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const creds = await resourceManager.provisionRedisTenant(testProjId);

      expect(creds.connectionUri).toContain('redis://');
      expect(creds.keyPrefix).toBeDefined();
      expect(creds.keyPrefix).toBe(`proj_${testProjId.toLowerCase()}:`);
    });
  });

  describe('Issue 6: Retention Manager Exact Record Targeting', () => {
    it('should target exact records without wiping unrelated lower-ID records', async () => {
      const projId = `proj_ret_${Date.now()}`;
      await db.insert(schema.projects).values({
        id: projId,
        name: 'Retention Test',
        slug: `ret-test-${Date.now()}`,
        repoUrl: 'https://github.com/example/ret',
        branch: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Insert older deployments (>500 chars log to trigger truncation)
      const oldDepId = `dep_100_${Date.now()}`;
      const recentDepId = `dep_200_${Date.now()}`;
      const longLogs = 'A'.repeat(600);

      await db.insert(schema.deployments).values([
        {
          id: oldDepId,
          projectId: projId,
          status: 'healthy',
          rawManifest: '{}',
          deploymentPlan: '{}',
          logs: longLogs,
          createdAt: Date.now() - 35 * 24 * 60 * 60 * 1000, // 35 days old
          updatedAt: Date.now() - 35 * 24 * 60 * 60 * 1000,
        },
        {
          id: recentDepId,
          projectId: projId,
          status: 'healthy',
          rawManifest: '{}',
          deploymentPlan: '{}',
          logs: 'recent logs',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

      const report = await retentionManager.pruneOldArtifacts(30);
      expect(report.prunedDeploymentLogs).toBe(1);

      const [pruned] = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.id, oldDepId));
      expect(pruned.logs).toContain('[Log Retention Policy] Truncated');

      const [active] = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.id, recentDepId));
      expect(active.logs).toBe('recent logs'); // Retained safely without collateral damage
    });
  });

  describe('Issue 8: Durable Approvals Bound to Cryptographic Plan Hash', () => {
    it('should persist pending approval in SQLite and verify plan hash before execution', async () => {
      const promptId = `prompt_test_${Date.now()}`;
      const plan = {
        projectName: 'Hash Verified App',
        runtime: 'node',
        port: 3000,
        suggestedSubdomain: 'hash-test',
        environmentVariables: [],
      };
      const planHash = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');

      // Store in SQLite
      await db.insert(schema.pendingApprovals).values({
        id: promptId,
        action: 'DEPLOY_CONFIRM',
        target: 'https://github.com/example/hash-test',
        planHash,
        details: JSON.stringify({
          deploymentId: 'dep_hash_1',
          projectId: 'proj_hash_1',
          plan,
        }),
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      });

      // Verify approval exists durably in SQLite
      const [stored] = await db
        .select()
        .from(schema.pendingApprovals)
        .where(eq(schema.pendingApprovals.id, promptId));
      expect(stored).toBeDefined();
      expect(stored.planHash).toBe(planHash);

      // Confirming with matching plan hash succeeds
      const result = await aiChatService.handleConfirmation(promptId, true);
      expect(result.success).toBe(true);

      const [approved] = await db
        .select()
        .from(schema.pendingApprovals)
        .where(eq(schema.pendingApprovals.id, promptId));
      expect(approved.status).toBe('approved');
    });

    it('should reject approval if plan was tampered with (plan hash mismatch)', async () => {
      const promptId = `prompt_tamper_${Date.now()}`;
      const originalPlan = {
        projectName: 'Original Safe App',
        port: 3000,
      };
      const originalHash = crypto.createHash('sha256').update(JSON.stringify(originalPlan)).digest('hex');

      const tamperedPlan = {
        projectName: 'Tampered Malicious App',
        port: 9999,
      };

      // Store approval with original hash but tampered plan details
      await db.insert(schema.pendingApprovals).values({
        id: promptId,
        action: 'DEPLOY_CONFIRM',
        target: 'https://github.com/example/tampered',
        planHash: originalHash,
        details: JSON.stringify({
          deploymentId: 'dep_tamper_1',
          projectId: 'proj_tamper_1',
          plan: tamperedPlan,
        }),
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      });

      const result = await aiChatService.handleConfirmation(promptId, true);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Plan integrity failure');

      const [rejected] = await db
        .select()
        .from(schema.pendingApprovals)
        .where(eq(schema.pendingApprovals.id, promptId));
      expect(rejected.status).toBe('rejected');
    });
  });
});
