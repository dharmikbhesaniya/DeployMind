import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { registerRoutes } from './routes.js';
import { config } from '../config/index.js';
import { authGuard, getAdminToken } from '../core/auth.js';

export async function createServer() {
  const app = Fastify({
    logger: {
      level: config.env === 'development' ? 'info' : 'warn',
    },
  });

  // Ensure admin token is initialized
  getAdminToken();

  // Strict CORS policy: Disallow open wildcard origin
  const allowedOrigins = [
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    `http://${config.host}:${config.port}`,
  ];
  if (process.env.DEPLOYMIND_ALLOWED_ORIGINS) {
    allowedOrigins.push(
      ...process.env.DEPLOYMIND_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    );
  }

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || process.env.NODE_ENV === 'test') {
        return cb(null, true);
      }
      const isAllowed =
        allowedOrigins.some((allowed) => {
          try {
            return new URL(origin).hostname === new URL(allowed).hostname;
          } catch {
            return origin === allowed;
          }
        }) ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:');

      if (isAllowed) {
        return cb(null, true);
      }
      cb(new Error('Cross-Origin Request Blocked: Origin not permitted by DeployMind policy.'), false);
    },
    credentials: true,
  });

  await app.register(websocket);

  // Enforce authentication across all control plane API endpoints
  app.addHook('onRequest', authGuard);

  // Register API routes
  await registerRoutes(app);

  // Serve static UI if web/dist exists
  const webDist = path.resolve(process.cwd(), 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
    });

    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  return app;
}
