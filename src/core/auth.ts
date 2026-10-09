import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/index.js';

let cachedToken: string | null = null;

/**
 * Retrieve or generate the DeployMind administrative control plane token.
 */
export function getAdminToken(): string {
  if (cachedToken) return cachedToken;

  const envToken = process.env.DEPLOYMIND_ADMIN_TOKEN || process.env.DEPLOYAGENT_ADMIN_TOKEN;
  if (envToken && envToken.trim()) {
    cachedToken = envToken.trim();
    return cachedToken;
  }

  const tokenPath = path.resolve(config.dataDir, 'admin_token.key');
  try {
    if (fs.existsSync(tokenPath)) {
      const savedToken = fs.readFileSync(tokenPath, 'utf8').trim();
      if (savedToken) {
        cachedToken = savedToken;
        return cachedToken;
      }
    }

    const generated = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, generated, { mode: 0o600 });
    cachedToken = generated;
    console.info(`[Auth] Generated new DeployMind control plane token: ${tokenPath}`);
    return cachedToken;
  } catch (err) {
    console.warn('[Auth] Could not write admin token to disk, using memory fallback:', err);
    cachedToken = crypto.randomBytes(32).toString('hex');
    return cachedToken;
  }
}

/**
 * Cryptographically secure constant-time token verification.
 */
export function verifyAdminToken(candidate: string | undefined | null): boolean {
  if (!candidate || typeof candidate !== 'string') return false;

  const expected = getAdminToken();
  const candidateBuf = Buffer.from(candidate);
  const expectedBuf = Buffer.from(expected);

  if (candidateBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}

/**
 * Helper to determine if a request originates from the local loopback interface.
 */
export function isLoopbackRequest(req: FastifyRequest): boolean {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLoopbackIp =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('127.0.0.1');

  const host = (req.headers.host || req.hostname || '').toLowerCase();
  const isLoopbackHost =
    host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    host.startsWith('[::1]');

  return isLoopbackIp || isLoopbackHost;
}

/**
 * Control Plane Authentication Guard for Fastify.
 */
export async function authGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = req.url.split('?')[0];

  // 1. Exempt public health, status, session bootstrap, webhooks, and static frontend routes
  if (
    url === '/health' ||
    url === '/api/health' ||
    url === '/api/system/health' ||
    url === '/api/system/status' ||
    url === '/api/auth/session' ||
    url === '/api/auth/verify' ||
    url.startsWith('/api/webhooks/') ||
    !url.startsWith('/api/')
  ) {
    if (!url.startsWith('/api/') && isLoopbackRequest(req)) {
      reply.header('Set-Cookie', `deploymind_token=${getAdminToken()}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return;
  }

  // 2. Allow test suite bypass if explicitly enabled or in test environment unless auth test is asserted
  if (process.env.DEPLOYMIND_DISABLE_AUTH === 'true') {
    return;
  }
  if (process.env.NODE_ENV === 'test' && !req.headers['x-test-enforce-auth']) {
    return;
  }

  // 3. Extract candidate token from Authorization header, x-api-key, cookie, or query param
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers['x-api-key']) {
    token = String(req.headers['x-api-key']).trim();
  } else if ((req.query as any)?.token) {
    token = String((req.query as any).token).trim();
  } else if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:deploymind_token|deploymind_admin_token)=([^;]+)/);
    if (match) {
      token = match[1].trim();
    }
  }

  // 4. Verify candidate token if provided
  if (token && verifyAdminToken(token)) {
    return;
  }

  // 5. If running on local loopback/localhost and auth enforcement is not explicitly mandated,
  // allow local control and attach session cookie seamlessly
  const isEnforced =
    process.env.DEPLOYMIND_ENFORCE_AUTH === 'true' ||
    req.headers['x-test-enforce-auth'] === 'true';

  if (!isEnforced && isLoopbackRequest(req)) {
    const adminToken = getAdminToken();
    reply.header('Set-Cookie', `deploymind_token=${adminToken}; Path=/; HttpOnly; SameSite=Lax`);
    return;
  }

  // 6. Otherwise deny with 401 Unauthorized
  reply.status(401).send({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'Access denied: Valid DeployMind administrative token required.',
  });
}
