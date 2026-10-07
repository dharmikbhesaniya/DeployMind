import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { docParser } from '../src/modules/doc-parser/doc.parser.js';
import { nativeRunner } from '../src/modules/native-runner/native.runner.js';
import { repoAnalyzer } from '../src/modules/analyzer/repo.analyzer.js';

describe('README Semantic Understanding and Runtime Strategy', () => {
  const sampleReadme = `# Payment Gateway Service

## Overview
High-performance payment routing and settlement gateway for multi-currency transactions.

## Architecture & How It Works
Ingests webhooks from external providers, records ledger entries in PostgreSQL, and enqueues events into Redis.

## Getting Started & Setup
1. Clone the repository
2. Install production dependencies: npm ci
3. Run database migrations: npx prisma migrate deploy
4. Build bundle: npm run build
5. Start service: npm start (port 8080)

## Environment Variables
- DATABASE_URL=postgresql://user:pass@localhost:5432/gateway
- REDIS_URL=redis://localhost:6379
- API_KEY=secret_live_key
`;

  it('should deeply parse README and extract architecture, setup workflow, and production commands', () => {
    const analysis = docParser.analyzeReadme(sampleReadme);

    expect(analysis.projectOverview).toContain('High-performance payment routing');
    expect(analysis.howItWorks).toContain('Ingests webhooks');
    expect(analysis.setupWorkflow.length).toBeGreaterThanOrEqual(3);
    expect(analysis.detectedBuildCommand).toBe('npm run build');
    expect(analysis.detectedStartCommand).toBe('npm start');
    expect(analysis.detectedPort).toBe(8080);
    expect(analysis.detectedMigrationCommand).toBe('npx prisma migrate deploy');
  });

  it('should reject dev mode commands and enforce production start commands', () => {
    const devReadme = `# My App
## Setup
Run npm run dev to start development server.
`;
    const devAnalysis = docParser.analyzeReadme(devReadme);
    // Should NOT detect npm run dev as start command
    expect(devAnalysis.detectedStartCommand).not.toBe('npm run dev');
  });

  it('should execute native runner strictly in production mode when Docker is offline', async () => {
    const fixtureDir = path.join(process.cwd(), '.data', 'test-fixture-' + Date.now());
    fs.mkdirSync(fixtureDir, { recursive: true });

    // Create minimal valid node app
    fs.writeFileSync(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({
        name: 'test-prod-app',
        scripts: {
          start: 'node server.js',
        },
      })
    );

    fs.writeFileSync(
      path.join(fixtureDir, 'server.js'),
      `const http = require('http');
const port = process.env.PORT || 9099;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ env: process.env.NODE_ENV, status: 'ok' }));
});
server.listen(port);
`
    );

    const procInfo = await nativeRunner.startProductionApp({
      deploymentId: 'dep_test_123',
      projectId: 'proj_test_native',
      sourceDir: fixtureDir,
      env: { CUSTOM_VAR: 'prod_val' },
      port: 9099,
      startCommand: 'npm start',
    });

    expect(procInfo.pid).toBeGreaterThan(0);
    expect(procInfo.status).toBe('running');
    expect(procInfo.port).toBe(9099);

    // Stop process
    await nativeRunner.stopApp('proj_test_native');

    // Clean up
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });
});
