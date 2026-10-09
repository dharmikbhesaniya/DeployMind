import { initDatabase } from './db/index.js';
import { createServer } from './server/index.js';
import { config } from './config/index.js';
import { proxyService } from './modules/proxy/proxy.service.js';
import { reconcilerService } from './modules/orchestration/reconciler.service.js';

// Global process protection and crash safety
process.on('unhandledRejection', (reason: any) => {
  console.error('[Process Safety] Fatal unhandled promise rejection caught:', reason?.message || reason);
  // Log fatal diagnostic and exit to prevent undefined runtime state
  process.exit(1);
});

process.on('uncaughtException', (err: any) => {
  console.error('[Process Safety] Fatal uncaught exception caught:', err?.message || err, err?.stack);
  // Exit cleanly so supervisor (Docker/systemd) restarts the process safely
  process.exit(1);
});

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
    await proxyService.syncDatabaseRoutes().catch((err) => {
      console.warn('[Bootstrap] Notice: Ingress proxy route sync deferred:', err?.message || err);
    });

    // Start background desired-state reconciler loop
    reconcilerService.start(30000);

    const shutdown = async () => {
      reconcilerService.stop();
      await server.close();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
