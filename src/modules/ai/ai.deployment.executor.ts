/**
 * AI Deployment Executor - Dynamic Command Execution Engine
 *
 * This replaces hardcoded deployment logic with AI-driven command execution.
 * Instead of static "if Node → npm install && npm build && npm start" logic,
 * this executor takes the AI Task Plan and dynamically runs the correct
 * commands for any application type — Node, Python, Go, Rust, Ruby, etc.
 *
 * Key principle: "The AI decides what commands to run, not prebuilt functions."
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { eventBus, type DeploymentLogEvent } from '../../core/events.js';
import { aiTaskEngine, type AITaskPlan } from './ai.task.engine.js';

export interface ExecutionResult {
  success: boolean;
  exitCode: number;
  output: string;
  duration: number;
}

export interface DeploymentExecution {
  taskPlan: AITaskPlan;
  installResult?: ExecutionResult;
  buildResult?: ExecutionResult;
  startResult?: { pid: number; port: number; command: string };
  testResult?: ExecutionResult;
  migrationResult?: ExecutionResult;
  staticServerGenerated?: boolean;
}

export class AIDeploymentExecutor {
  private activeProcesses = new Map<string, ChildProcess>();

  /**
   * Execute the full AI-driven deployment pipeline for a project.
   * The AI Task Engine determines all commands dynamically.
   */
  async executeAIDrivenDeployment(params: {
    deploymentId: string;
    projectId: string;
    sourceDir: string;
    env: Record<string, string>;
    port: number;
    runTests?: boolean;
    runMigrations?: boolean;
  }): Promise<DeploymentExecution> {
    const { deploymentId, projectId, sourceDir, env, runTests, runMigrations } = params;

    // 1. AI synthesizes the task plan dynamically
    eventBus.emitLog({
      deploymentId,
      timestamp: Date.now(),
      level: 'info',
      stage: 'plan',
      message: '[AI Deployment Executor] Inspecting repository to synthesize dynamic task plan...',
    });

    const taskPlan = await aiTaskEngine.synthesizeTaskPlan(sourceDir, deploymentId);

    // Override port if specified
    const effectivePort = params.port || taskPlan.port;

    const prodEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...env,
      NODE_ENV: 'production',
      PORT: effectivePort.toString(),
      PYTHONUNBUFFERED: '1',
      CI: 'true',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CODE_SIGN_IDENTITY: '-',
      CODE_SIGNING_REQUIRED: 'NO',
      CODE_SIGNING_ALLOWED: 'NO',
    };

    const execution: DeploymentExecution = { taskPlan };

    // 2. INSTALL DEPENDENCIES (AI-determined command)
    if (taskPlan.installCommand) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'build',
        message: `[AI Deployment Executor] Installing dependencies: ${taskPlan.installCommand}`,
      });

      execution.installResult = await this.runCommand(
        sourceDir, taskPlan.installCommand, prodEnv, deploymentId, 'install', 300000 // 5 min timeout
      );

      if (!execution.installResult.success) {
        // Retry with fallback install
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'warn',
          stage: 'build',
          message: `[AI Deployment Executor] Primary install failed (exit ${execution.installResult.exitCode}). Attempting fallback...`,
        });

        const fallbackCmd = this.getFallbackInstallCommand(taskPlan);
        if (fallbackCmd) {
          execution.installResult = await this.runCommand(
            sourceDir, fallbackCmd, prodEnv, deploymentId, 'install-fallback', 300000
          );
        }
      }
    }

    // 3. RUN DATABASE MIGRATIONS (AI-determined command)
    if (runMigrations !== false && taskPlan.migrationCommand) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'build',
        message: `[AI Deployment Executor] Running database migration: ${taskPlan.migrationCommand}`,
      });

      execution.migrationResult = await this.runCommand(
        sourceDir, taskPlan.migrationCommand, prodEnv, deploymentId, 'migration', 120000
      );

      if (!execution.migrationResult.success) {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'warn',
          stage: 'build',
          message: `[AI Deployment Executor] Migration completed with exit code ${execution.migrationResult.exitCode}. This may be expected if migrations are already applied.`,
        });
      }
    }

    // 4. BUILD PRODUCTION ASSETS (AI-determined command)
    if (taskPlan.buildCommand) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'build',
        message: `[AI Deployment Executor] Building production assets: ${taskPlan.buildCommand}`,
      });

      execution.buildResult = await this.runCommand(
        sourceDir, taskPlan.buildCommand, prodEnv, deploymentId, 'build', 600000 // 10 min timeout
      );

      if (!execution.buildResult.success) {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'warn',
          stage: 'build',
          message: `[AI Deployment Executor] Build step completed with exit code ${execution.buildResult.exitCode}. Proceeding with available output.`,
        });
      }
    }

    // 5. GENERATE STATIC SERVER if needed (AI determined)
    if (taskPlan.needsStaticServer) {
      this.generateStaticServer(sourceDir, effectivePort);
      execution.staticServerGenerated = true;
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'build',
        message: `[AI Deployment Executor] Generated production static file server for SPA (port ${effectivePort})`,
      });
    }

    // 6. RUN TESTS (AI-determined command, optional)
    if (runTests && taskPlan.testCommand) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'test',
        message: `[AI Deployment Executor] Running tests: ${taskPlan.testCommand}`,
      });

      execution.testResult = await this.runCommand(
        sourceDir, taskPlan.testCommand, prodEnv, deploymentId, 'test', 300000
      );

      if (!execution.testResult.success) {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'warn',
          stage: 'test',
          message: `[AI Deployment Executor] Tests completed with exit code ${execution.testResult.exitCode}. Deployment will continue.`,
        });
      }
    }

    // 7. START THE APPLICATION (AI-determined command)
    const startCommand = taskPlan.needsStaticServer
      ? 'node deploymind-server.cjs'
      : taskPlan.startCommand;

    if (startCommand) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'deploy',
        message: `[AI Deployment Executor] Starting production application: ${startCommand} (port ${effectivePort})`,
      });

      const startResult = await this.startProcess(
        projectId, sourceDir, startCommand, prodEnv, deploymentId
      );

      execution.startResult = {
        pid: startResult.pid,
        port: effectivePort,
        command: startCommand,
      };
    } else {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'error',
        stage: 'deploy',
        message: '[AI Deployment Executor] No start command could be determined for this application. Manual configuration required.',
      });
    }

    return execution;
  }

  /**
   * Run a single command synchronously and return the result.
   */
  private async runCommand(
    cwd: string,
    command: string,
    env: Record<string, string>,
    deploymentId: string,
    stage: DeploymentLogEvent['stage'],
    timeoutMs: number = 120000
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const parts = this.parseCommand(command);
      let output = '';

      const mergedEnv = {
        ...process.env,
        ...env,
        PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
      };

      try {
        const proc = spawn(parts.cmd, parts.args, {
          cwd,
          env: mergedEnv,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const timeout = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          resolve({
            success: false,
            exitCode: -1,
            output: output + '\n[TIMEOUT] Command exceeded time limit',
            duration: Date.now() - startTime,
          });
        }, timeoutMs);

        proc.stdout?.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          output += text;
          // Stream last portion of output to deployment logs
          const lastLine = text.trim().split('\n').pop() || '';
          if (lastLine.length > 0) {
            eventBus.emitLog({
              deploymentId,
              timestamp: Date.now(),
              level: 'info',
              stage,
              message: `[${stage}] ${lastLine.slice(0, 300)}`,
            });
          }
        });

        proc.stderr?.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          output += text;
        });

        proc.on('close', (code) => {
          clearTimeout(timeout);
          resolve({
            success: code === 0,
            exitCode: code ?? -1,
            output: output.slice(-5000), // Keep last 5KB
            duration: Date.now() - startTime,
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          resolve({
            success: false,
            exitCode: -1,
            output: err.message,
            duration: Date.now() - startTime,
          });
        });
      } catch (err: any) {
        resolve({
          success: false,
          exitCode: -1,
          output: err.message,
          duration: Date.now() - startTime,
        });
      }
    });
  }

  /**
   * Start a long-running process (the application server).
   */
  private async startProcess(
    projectId: string,
    cwd: string,
    command: string,
    env: Record<string, string>,
    deploymentId: string
  ): Promise<{ pid: number }> {
    // Stop existing process
    this.stopProcess(projectId);

    const parts = this.parseCommand(command);
    const mergedEnv = {
      ...process.env,
      ...env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
    };

    const logFile = path.join(cwd, 'app.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    const child = spawn(parts.cmd, parts.args, {
      cwd,
      env: mergedEnv,
      shell: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!child.pid) {
      throw new Error(`Failed to start process: ${command}`);
    }

    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    child.stdout?.on('data', (chunk) => {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'deploy',
        message: chunk.toString('utf8').trim().slice(0, 300),
      });
    });

    child.stderr?.on('data', (chunk) => {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'warn',
        stage: 'deploy',
        message: chunk.toString('utf8').trim().slice(0, 300),
      });
    });

    this.activeProcesses.set(projectId, child);

    child.on('exit', (code) => {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: code === 0 ? 'info' : 'error',
        stage: 'deploy',
        message: `[AI Deployment Executor] Process exited with code ${code}`,
      });
    });

    return { pid: child.pid };
  }

  /**
   * Stop a running process.
   */
  stopProcess(projectId: string): boolean {
    const existing = this.activeProcesses.get(projectId);
    if (existing?.pid) {
      try {
        existing.kill('SIGTERM');
        setTimeout(() => {
          try { existing.kill('SIGKILL'); } catch { /* already dead */ }
        }, 3000);
      } catch { /* ignored */ }
      this.activeProcesses.delete(projectId);
      return true;
    }
    return false;
  }

  /**
   * Get all currently running processes.
   */
  getRunningProcesses(): Array<{ projectId: string; pid: number }> {
    const procs: Array<{ projectId: string; pid: number }> = [];
    for (const [projectId, child] of this.activeProcesses.entries()) {
      if (child.pid) {
        procs.push({ projectId, pid: child.pid });
      }
    }
    return procs;
  }

  /**
   * Check if a managed process is still running.
   */
  isProcessRunning(projectId: string): boolean {
    const proc = this.activeProcesses.get(projectId);
    if (!proc || !proc.pid) return false;
    try {
      process.kill(proc.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse a command string into cmd and args.
   */
  private parseCommand(command: string): { cmd: string; args: string[] } {
    const parts = command.split(/\s+/);
    return { cmd: parts[0], args: parts.slice(1) };
  }

  /**
   * Generate a production-grade static file server for SPAs.
   */
  private generateStaticServer(dir: string, port: number): void {
    const distDir = fs.existsSync(path.join(dir, 'dist', 'index.html'))
      ? 'dist'
      : fs.existsSync(path.join(dir, 'build', 'index.html'))
      ? 'build'
      : fs.existsSync(path.join(dir, 'out', 'index.html'))
      ? 'out'
      : fs.existsSync(path.join(dir, 'public', 'index.html'))
      ? 'public'
      : 'dist';

    const serverScript = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const port = parseInt(process.env.PORT || '${port}', 10);
const root = path.join(__dirname, '${distDir}');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json'
};
const server = http.createServer((req, res) => {
  let reqPath = decodeURI(req.url.split('?')[0]);
  let filePath = path.join(root, reqPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.join(root, 'index.html');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const isImmutable = ext !== '.html' && reqPath.includes('.');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': isImmutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  });
});
server.listen(port, '0.0.0.0', () => {
  console.log('[DeployMind Static Server] Serving ' + root + ' on 0.0.0.0:' + port);
});
`;
    fs.writeFileSync(path.join(dir, 'deploymind-server.cjs'), serverScript, 'utf8');
  }

  /**
   * Determine a fallback install command if primary fails.
   */
  private getFallbackInstallCommand(plan: AITaskPlan): string | null {
    if (plan.runtime === 'node') {
      if (plan.packageManager === 'pnpm') return 'pnpm install';
      if (plan.packageManager === 'yarn') return 'yarn install';
      return 'npm install --prefer-offline';
    }
    if (plan.runtime === 'python') {
      return 'pip install --no-cache-dir -r requirements.txt';
    }
    return null;
  }

  /**
   * Run deployment health validation after start.
   * Checks if the application is actually responding on the expected port.
   */
  async validateDeploymentHealth(
    port: number,
    deploymentId: string,
    maxRetries = 10,
    intervalMs = 3000
  ): Promise<{ healthy: boolean; statusCode?: number; error?: string }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (res.ok || res.status < 500) {
          eventBus.emitLog({
            deploymentId,
            timestamp: Date.now(),
            level: 'success',
            stage: 'health',
            message: `[AI Deployment Executor] Health check passed on port ${port} (HTTP ${res.status}) after ${attempt} attempt(s)`,
          });
          return { healthy: true, statusCode: res.status };
        }
      } catch {
        // Not ready yet
      }

      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    return {
      healthy: false,
      error: `Application not responding on port ${port} after ${maxRetries} attempts`,
    };
  }
}

export const aiDeploymentExecutor = new AIDeploymentExecutor();
