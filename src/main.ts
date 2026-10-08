import { initDatabase } from './db/index.js';
import { createServer } from './server/index.js';
import { config } from './config/index.js';
import { proxyService } from './modules/proxy/proxy.service.js';

async function bootstrap() {
  console.log('🚀 Initializing DeployMind Modular Monolith...');
  
  // Initialize embedded SQLite database with WAL mode
  initDatabase();
  console.log(`📦 Embedded SQLite initialized at: ${config.dbPath}`);

  // Create and start Fastify API & WebSocket server
  const server = await createServer();

  try {
    await server.listen({ port: config.port, host: config.host });
    console.log(`🌐 DeployMind running at http://${config.host}:${config.port}`);
    console.log(`🔌 Selected Ingress Proxy: ${config.proxy.provider.toUpperCase()}`);
    console.log(`🧠 AI Reasoner Provider: ${config.ai.provider.toUpperCase()} (${config.ai.model})`);

    // Warm up reverse proxy ingress & restore persisted routes
    proxyService.syncDatabaseRoutes().catch((err) => {
      console.warn('[Bootstrap] Notice: Ingress proxy route sync deferred:', err?.message || err);
    });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
