import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../src/server/index.js';
import { initDatabase } from '../src/db/index.js';
import type { FastifyInstance } from 'fastify';

describe('DeployAgent Monolith REST API Endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initDatabase();
    app = await createServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/system/status should return operational status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/status',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('operational');
    expect(body.engine).toBe('DeployMind Modular Monolith');
    expect(body.proxy).toBeDefined();
  });

  it('POST /api/vault/credentials should create credentials and permit duplicates with descriptions', async () => {
    // 1. Create first credential
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/vault/credentials',
      payload: {
        keyName: 'STRIPE_API_KEY',
        value: 'sk_live_11223344556677889900',
        description: 'US Production Stripe Account',
        scope: 'GLOBAL',
      },
    });

    expect(res1.statusCode).toBe(200);
    const cred1 = JSON.parse(res1.payload);
    expect(cred1.keyName).toBe('STRIPE_API_KEY');
    expect(cred1.description).toBe('US Production Stripe Account');
    expect(cred1.maskedPreview).toBe('sk_l...9900');

    // 2. Create second credential with identical key name (duplicate)
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/vault/credentials',
      payload: {
        keyName: 'STRIPE_API_KEY',
        value: 'sk_test_99887766554433221100',
        description: 'EU Sandbox Stripe Testing Account',
        scope: 'GLOBAL',
      },
    });

    expect(res2.statusCode).toBe(200);
    const cred2 = JSON.parse(res2.payload);
    expect(cred2.keyName).toBe('STRIPE_API_KEY');
    expect(cred2.description).toBe('EU Sandbox Stripe Testing Account');
    expect(cred2.id).not.toBe(cred1.id);

    // 3. List all credentials
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/vault/credentials',
    });

    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.payload);
    const stripeKeys = list.filter((c: any) => c.keyName === 'STRIPE_API_KEY');
    expect(stripeKeys.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/projects should return project list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
    });

    expect(res.statusCode).toBe(200);
    const projects = JSON.parse(res.payload);
    expect(Array.isArray(projects)).toBe(true);
  });

  it('GET /api/routes should return proxy routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/routes',
    });

    expect(res.statusCode).toBe(200);
    const routes = JSON.parse(res.payload);
    expect(Array.isArray(routes)).toBe(true);
  });

  it('POST /api/backups/run and GET /api/backups should manage automated backups', async () => {
    const runRes = await app.inject({
      method: 'POST',
      url: '/api/backups/run',
    });

    expect(runRes.statusCode).toBe(200);
    const runBody = JSON.parse(runRes.payload);
    expect(runBody.success).toBe(true);
    expect(Array.isArray(runBody.created)).toBe(true);

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/backups',
    });

    expect(listRes.statusCode).toBe(200);
    const backups = JSON.parse(listRes.payload);
    expect(Array.isArray(backups)).toBe(true);
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/deployments/auto-deploy should run 1-click zero-touch deployment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/deployments/auto-deploy',
      payload: {
        repoUrl: 'https://github.com/example/sample-app',
        projectName: 'Sample Autonomous App',
      },
    });

    if (res.statusCode !== 200) {
      console.error("AUTO DEPLOY ERROR:", res.payload);
    }
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.projectId).toBeDefined();
    expect(body.deploymentId).toBeDefined();
    expect(body.liveUrl).toBeDefined();
    expect(body.plan).toBeDefined();
  }, 25000);

  it('POST /api/ai/chat should process natural conversation with TypeSafe Jev decision classification', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: {
        message: 'What services are running right now?',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.message).toBeDefined();
    expect(body.intent).toBeDefined();
    expect(body.intent.choice).toBe('SYSTEM_STATUS');
    expect(body.intent.confidence).toBeGreaterThan(0.8);
    expect(body.intent.riskLevel).toBe('SAFE');
  });

  it('POST /api/ai/chat should trigger interactive permission request for destructive operations', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: {
        message: 'Delete project sample-autonomous-app completely',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.intent.choice).toBe('DELETE_PROJECT');
    expect(body.intent.riskLevel).toBe('DESTRUCTIVE');
    expect(body.interactivePrompt).toBeDefined();
    expect(body.interactivePrompt.type).toBe('permission_request');
    expect(body.interactivePrompt.confidence).toBeGreaterThanOrEqual(90);

    // Test confirmation denial
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/ai/chat/confirm',
      payload: {
        promptId: body.interactivePrompt.id,
        approved: false,
      },
    });

    expect(confirmRes.statusCode).toBe(200);
    const confirmBody = JSON.parse(confirmRes.payload);
    expect(confirmBody.success).toBe(true);
    expect(confirmBody.message).toContain('cancelled');
  });
});
