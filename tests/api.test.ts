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
    expect(body.engine).toBe('DeployAgent Modular Monolith');
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
});
