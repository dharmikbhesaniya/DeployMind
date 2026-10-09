import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { aiTaskEngine } from '../src/modules/ai/ai.task.engine.js';
import { aiDependencyManager } from '../src/modules/ai/ai.dependency.manager.js';
import { aiDeploymentExecutor } from '../src/modules/ai/ai.deployment.executor.js';

describe('AI Task Engine & Dynamic Execution Architecture', () => {
  const tmpDir = path.join(process.cwd(), '.data', 'ai-engine-test-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('Dynamic Task Plan Synthesis (Non-Hardcoded)', () => {
    it('should dynamically synthesize Node.js task plan with pnpm', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'ai-pnpm-app',
          scripts: {
            build: 'tsc -p tsconfig.json',
            start: 'node dist/index.js',
            test: 'vitest run',
            migrate: 'prisma migrate deploy',
          },
        })
      );
      fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4');

      const plan = await aiTaskEngine.synthesizeTaskPlan(tmpDir);

      expect(plan.runtime).toBe('node');
      expect(plan.packageManager).toBe('pnpm');
      expect(plan.installCommand).toBe('pnpm install --frozen-lockfile');
      expect(plan.buildCommand).toBe('pnpm run build');
      expect(plan.startCommand).toBe('pnpm run start');
      expect(plan.testCommand).toBe('pnpm test');
      expect(plan.migrationCommand).toBe('pnpm run migrate');
      expect(plan.confidence).toBeGreaterThan(0.9);
      expect(plan.reasoning.length).toBeGreaterThan(0);
    });

    it('should dynamically synthesize Python task plan with poetry', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'pyproject.toml'),
        `[tool.poetry]
name = "ai-python-service"
version = "0.1.0"
description = "FastAPI AI service"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.100.0"
`
      );
      fs.writeFileSync(path.join(tmpDir, 'poetry.lock'), '# poetry lock');
      fs.writeFileSync(path.join(tmpDir, 'main.py'), 'print("hello")');

      const plan = await aiTaskEngine.synthesizeTaskPlan(tmpDir);

      expect(plan.runtime).toBe('python');
      expect(plan.packageManager).toBe('poetry');
      expect(plan.installCommand).toBe('poetry install --no-interaction --no-ansi');
      expect(plan.startCommand).toContain('uvicorn main:app');
      expect(plan.systemDependencies.some((d) => d === 'python3')).toBe(true);
      expect(plan.systemDependencies.some((d) => d === 'poetry')).toBe(true);
    });

    it('should dynamically synthesize Go task plan', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'go.mod'),
        `module github.com/example/goservice

go 1.22
`
      );
      fs.writeFileSync(path.join(tmpDir, 'main.go'), 'package main\nfunc main() {}');

      const plan = await aiTaskEngine.synthesizeTaskPlan(tmpDir);

      expect(plan.runtime).toBe('go');
      expect(plan.installCommand).toBe('go mod download');
      expect(plan.buildCommand).toBe('go build -o app .');
      expect(plan.startCommand).toBe('./app');
      expect(plan.testCommand).toBe('go test ./...');
      expect(plan.systemDependencies.includes('go')).toBe(true);
    });

    it('should dynamically synthesize Rust task plan', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'Cargo.toml'),
        `[package]
name = "rust-microservice"
version = "0.1.0"
edition = "2021"
`
      );
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'main.rs'), 'fn main() {}');

      const plan = await aiTaskEngine.synthesizeTaskPlan(tmpDir);

      expect(plan.runtime).toBe('rust');
      expect(plan.installCommand).toBe('cargo fetch');
      expect(plan.buildCommand).toBe('cargo build --release');
      expect(plan.startCommand).toContain('rust-microservice');
      expect(plan.testCommand).toBe('cargo test');
      expect(plan.systemDependencies.includes('cargo')).toBe(true);
    });

    it('should detect and reject desktop GUI applications from server deployment', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'electron-desktop-tool',
          dependencies: {
            electron: '^28.0.0',
          },
          scripts: {
            start: 'electron .',
          },
        })
      );

      const plan = await aiTaskEngine.synthesizeTaskPlan(tmpDir);

      expect(plan.isDesktopApp).toBe(true);
      expect(plan.desktopFramework).toBe('electron');
      expect(plan.warnings?.some((w) => w.includes('Desktop GUI application'))).toBe(true);
    });
  });

  describe('AI Dependency Manager (ASK vs AUTO Mode)', () => {
    it('should analyze system dependencies and detect availability', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'dep-check-app',
          scripts: { start: 'node index.js' },
        })
      );

      const plan = await aiTaskEngine.synthesizeTaskPlan(tmpDir);
      const depChecks = await aiDependencyManager.analyzeDependencies(plan);

      expect(Array.isArray(depChecks)).toBe(true);
      // node should be installed since vitest is running in Node
      const nodeCheck = depChecks.find((d) => d.name === 'node');
      expect(nodeCheck).toBeDefined();
      expect(nodeCheck?.installed).toBe(true);
    });

    it('should respect ASK mode and track pending approvals', async () => {
      aiDependencyManager.setMode('ASK');
      expect(aiDependencyManager.getMode()).toBe('ASK');

      // Test missing dependency resolution in ASK mode
      const simulatedMissing = [
        {
          name: 'custom-compiler-tool',
          purpose: 'Required to build native extensions',
          installCommand: 'brew install custom-compiler-tool',
          checkCommand: 'which custom-compiler-tool',
          installed: false,
          required: true,
          category: 'system_lib' as const,
        },
      ];

      const { installed, pendingApproval } = await aiDependencyManager.installMissingDependencies(simulatedMissing);

      expect(installed.length).toBe(0);
      expect(pendingApproval.length).toBe(1);
      expect(pendingApproval[0].name).toBe('custom-compiler-tool');
    });

    it('should allow user approval and update dependency resolution', async () => {
      const simulatedDep = {
        name: 'test-tool',
        purpose: 'Testing approval workflow',
        installCommand: 'echo installed',
        checkCommand: 'echo ok',
        installed: false,
        required: true,
        category: 'tool' as const,
      };

      const approveRes = await aiDependencyManager.approveDependency('test-tool', simulatedDep);
      expect(approveRes.installed).toBe(true);
    });
  });

  describe('AI Deployment Executor Process Tracking', () => {
    it('should maintain running process registry and allow query', () => {
      const activeProcesses = aiDeploymentExecutor.getRunningProcesses();
      expect(Array.isArray(activeProcesses)).toBe(true);

      const isRunning = aiDeploymentExecutor.isProcessRunning('non-existent-id');
      expect(isRunning).toBe(false);

      const stopped = aiDeploymentExecutor.stopProcess('non-existent-id');
      expect(stopped).toBe(false);
    });
  });
});
