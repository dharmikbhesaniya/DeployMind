import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../../config/index.js';
import { eventBus } from '../../core/events.js';

export interface NativeProcessInfo {
  projectId: string;
  pid: number;
  port: number;
  appDir: string;
  status: 'running' | 'stopped' | 'failed';
  startedAt: number;
}

export class NativeRunner {
  private activeProcesses = new Map<string, { process: ChildProcess; info: NativeProcessInfo }>();
  private appsDir: string;

  constructor() {
    this.appsDir = path.join(config.dataDir, 'native-apps');
    if (!fs.existsSync(this.appsDir)) {
      fs.mkdirSync(this.appsDir, { recursive: true });
    }
  }

  // Prepares repository directory and runs in strictly optimized PRODUCTION mode
  async startProductionApp(params: {
    deploymentId: string;
    projectId: string;
    sourceDir: string;
    env: Record<string, string>;
    port: number;
    runtime?: string;
    buildCommand?: string;
    startCommand?: string;
  }): Promise<NativeProcessInfo> {
    const targetDir = path.join(this.appsDir, params.projectId);

    // Stop existing process if running
    await this.stopApp(params.projectId);

    // Sync or copy application files to app directory
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    eventBus.emitLog({
      deploymentId: params.deploymentId,
      timestamp: Date.now(),
      level: 'info',
      stage: 'build',
      message: `[Native Runner] Preparing repository for direct host execution in strict PRODUCTION mode...`,
    });

    // Copy source files excluding unnecessary dev/git directories to optimize disk storage
    this.copyProductionFiles(params.sourceDir, targetDir);

    // Ensure strict production environment
    const prodEnv: Record<string, string> = {
      ...process.env,
      ...params.env,
      NODE_ENV: 'production',
      PORT: params.port.toString(),
      PYTHONUNBUFFERED: '1',
    };

    // Install production dependencies & run build if applicable
    await this.prepareProductionDependencies(params.deploymentId, targetDir, prodEnv, params.runtime, params.buildCommand);

    // Determine production start command
    const startCmd = this.resolveProductionStartCommand(targetDir, params.runtime, params.startCommand, params.port);

    eventBus.emitLog({
      deploymentId: params.deploymentId,
      timestamp: Date.now(),
      level: 'info',
      stage: 'deploy',
      message: `[Native Runner] Launching production process on port ${params.port}: ${startCmd.command} ${startCmd.args.join(' ')}`,
    });

    const logFile = path.join(targetDir, 'app.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    // Spawn production background process with resource awareness
    const child = spawn(startCmd.command, startCmd.args, {
      cwd: targetDir,
      env: prodEnv,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!child.pid) {
      throw new Error('Failed to spawn native host production process');
    }

    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    child.stdout?.on('data', (chunk) => {
      eventBus.emitLog({
        deploymentId: params.deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'deploy',
        message: chunk.toString('utf8').trim().slice(0, 300),
      });
    });

    child.stderr?.on('data', (chunk) => {
      eventBus.emitLog({
        deploymentId: params.deploymentId,
        timestamp: Date.now(),
        level: 'warn',
        stage: 'deploy',
        message: chunk.toString('utf8').trim().slice(0, 300),
      });
    });

    const info: NativeProcessInfo = {
      projectId: params.projectId,
      pid: child.pid,
      port: params.port,
      appDir: targetDir,
      status: 'running',
      startedAt: Date.now(),
    };

    this.activeProcesses.set(params.projectId, { process: child, info });

    child.on('exit', (code) => {
      if (this.activeProcesses.get(params.projectId)?.info) {
        this.activeProcesses.get(params.projectId)!.info.status = code === 0 ? 'stopped' : 'failed';
      }
    });

    return info;
  }

  // Stop running native app
  async stopApp(projectId: string): Promise<void> {
    const active = this.activeProcesses.get(projectId);
    if (active && active.process.pid) {
      try {
        active.process.kill('SIGTERM');
        // Give 3 seconds then force kill
        setTimeout(() => {
          try {
            active.process.kill('SIGKILL');
          } catch {
            // Already dead
          }
        }, 3000);
      } catch {
        // Ignored
      }
      this.activeProcesses.delete(projectId);
    }
  }

  // Read tail of app log
  getAppLogs(projectId: string, maxLines = 100): string {
    const logFile = path.join(this.appsDir, projectId, 'app.log');
    if (!fs.existsSync(logFile)) return '';
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-maxLines).join('\n');
  }

  private async prepareProductionDependencies(
    deploymentId: string,
    dir: string,
    env: Record<string, string>,
    runtime?: string,
    customBuild?: string
  ): Promise<void> {
    const isNode = fs.existsSync(path.join(dir, 'package.json'));
    const isPython = fs.existsSync(path.join(dir, 'requirements.txt')) || fs.existsSync(path.join(dir, 'pyproject.toml'));

    if (isNode) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'build',
        message: `[Native Runner] Preparing Node dependencies and compiling production bundle...`,
      });

      // 1. Install dependencies if node_modules is missing
      if (!fs.existsSync(path.join(dir, 'node_modules'))) {
        try {
          await this.runSubprocess(dir, 'npm', ['ci', '--prefer-offline'], env).catch(() =>
            this.runSubprocess(dir, 'npm', ['install', '--production=false', '--prefer-offline'], env)
          );
        } catch (err: any) {
          eventBus.emitLog({
            deploymentId,
            timestamp: Date.now(),
            level: 'warn',
            stage: 'build',
            message: `[Native Runner] Notice: npm install skipped or offline (${err.message}). Proceeding with existing dependencies.`,
          });
        }
      }

      // 2. Run build if build script exists or custom command provided
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (customBuild) {
          const parts = customBuild.split(' ');
          await this.runSubprocess(dir, parts[0], parts.slice(1), env);
        } else if (pkg.scripts?.build) {
          await this.runSubprocess(dir, 'npm', ['run', 'build'], env);
        }
      } catch (err: any) {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'warn',
          stage: 'build',
          message: `[Native Runner] Build step notice: ${err.message}`,
        });
      }

      // 3. Storage optimization: Prune dev dependencies after build to save maximum VPS disk space
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'build',
        message: `[Native Runner] Resource Optimization: Pruning devDependencies to conserve VPS disk storage and memory...`,
      });
      await this.runSubprocess(dir, 'npm', ['prune', '--production'], env).catch(() => {});
    } else if (isPython) {
      if (fs.existsSync(path.join(dir, 'requirements.txt'))) {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'info',
          stage: 'build',
          message: `[Native Runner] Installing Python production requirements...`,
        });
        await this.runSubprocess(dir, 'pip', ['install', '--no-cache-dir', '-r', 'requirements.txt'], env).catch((err: any) => {
          eventBus.emitLog({
            deploymentId,
            timestamp: Date.now(),
            level: 'warn',
            stage: 'build',
            message: `[Native Runner] Notice: pip install notice (${err.message}). Proceeding.`,
          });
        });
      }
    }
  }

  private resolveProductionStartCommand(
    dir: string,
    runtime?: string,
    customStart?: string,
    port = 3000
  ): { command: string; args: string[] } {
    if (customStart) {
      // Strictly prevent running in dev mode
      const lower = customStart.toLowerCase();
      if (lower.includes('run dev') || lower.includes('--dev') || lower.includes('nodemon') || lower.includes('vite')) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
          if (pkg.scripts?.start) {
            return { command: 'npm', args: ['start'] };
          }
        }
      } else {
        const parts = customStart.split(' ');
        return { command: parts[0], args: parts.slice(1) };
      }
    }

    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.scripts?.start) {
        return { command: 'npm', args: ['start'] };
      }
      if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) {
        return { command: 'node', args: ['--max-old-space-size=512', pkg.main] };
      }
      if (fs.existsSync(path.join(dir, 'dist', 'main.js'))) {
        return { command: 'node', args: ['--max-old-space-size=512', 'dist/main.js'] };
      }
      if (fs.existsSync(path.join(dir, 'dist', 'index.js'))) {
        return { command: 'node', args: ['--max-old-space-size=512', 'dist/index.js'] };
      }
      if (fs.existsSync(path.join(dir, 'server.js'))) {
        return { command: 'node', args: ['--max-old-space-size=512', 'server.js'] };
      }
      return { command: 'npm', args: ['start'] };
    }

    if (fs.existsSync(path.join(dir, 'app.py'))) {
      return { command: 'python', args: ['app.py'] };
    }
    if (fs.existsSync(path.join(dir, 'main.py'))) {
      return { command: 'python', args: ['main.py'] };
    }

    return { command: 'npm', args: ['start'] };
  }

  private runSubprocess(cwd: string, cmd: string, args: string[], env: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd, env, stdio: 'ignore' });
      p.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Command ${cmd} exited with code ${code}`));
      });
      p.on('error', reject);
    });
  }

  private copyProductionFiles(src: string, dest: string) {
    if (!fs.existsSync(src)) return;
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      // Exclude heavy dev directories to save disk space
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === '.data' ||
        entry.name === '.next' ||
        entry.name === 'coverage'
      ) {
        continue;
      }

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        this.copyProductionFiles(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

export const nativeRunner = new NativeRunner();
