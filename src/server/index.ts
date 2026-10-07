import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { registerRoutes } from './routes.js';
import { config } from '../config/index.js';

export async function createServer() {
  const app = Fastify({
    logger: {
      level: config.env === 'development' ? 'info' : 'warn',
    },
  });

  await app.register(cors, {
    origin: true,
  });

  await app.register(websocket);

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
