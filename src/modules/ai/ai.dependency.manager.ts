/**
 * AI Dependency Manager - Dynamic Tool & Dependency Discovery and Installation
 *
 * Handles the requirement: "if need to download any tool/application as dependency
 * then also ask user want to download and what is the use of that dependency
 * explain properly. Also give auto full access or ask mode."
 *
 * This module:
 * 1. Inspects the repository and AI Task Plan to discover required system dependencies
 * 2. Checks if they are already installed on the host
 * 3. In ASK mode: prompts the user with explanation before installing
 * 4. In AUTO mode: installs automatically
 */

import { spawn } from 'node:child_process';
import { eventBus } from '../../core/events.js';
import { settingsService } from '../settings/settings.service.js';
import type { AITaskPlan } from './ai.task.engine.js';

export interface DependencyCheck {
  name: string;
  purpose: string;
  installCommand: string;
  checkCommand: string;
  installed: boolean;
  version?: string;
  required: boolean;
  category: 'runtime' | 'build_tool' | 'system_lib' | 'package_manager';
}

export interface DependencyInstallResult {
  name: string;
  installed: boolean;
  output?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

// Well-known dependency catalog with install instructions per platform
const DEPENDENCY_CATALOG: Record<string, {
  purpose: string;
  checkCommand: string;
  installCommands: { darwin: string; linux: string };
  category: DependencyCheck['category'];
}> = {
  docker: {
    purpose: 'Container runtime for isolated application sandboxing. Provides reproducible builds and network-level isolation between deployed services.',
    checkCommand: 'docker --version',
    installCommands: {
      darwin: 'brew install --cask docker',
      linux: 'curl -fsSL https://get.docker.com | sh',
    },
    category: 'runtime',
  },
  node: {
    purpose: 'JavaScript/TypeScript runtime environment. Required for building and running Node.js applications.',
    checkCommand: 'node --version',
    installCommands: {
      darwin: 'brew install node',
      linux: 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs',
    },
    category: 'runtime',
  },
  python3: {
    purpose: 'Python runtime environment. Required for running Python web applications (Django, Flask, FastAPI, etc.).',
    checkCommand: 'python3 --version',
    installCommands: {
      darwin: 'brew install python3',
      linux: 'sudo apt-get install -y python3 python3-pip python3-venv',
    },
    category: 'runtime',
  },
  go: {
    purpose: 'Go programming language runtime. Required for compiling and running Go-based applications.',
    checkCommand: 'go version',
    installCommands: {
      darwin: 'brew install go',
      linux: 'wget https://go.dev/dl/go1.23.0.linux-amd64.tar.gz && sudo tar -C /usr/local -xzf go1.23.0.linux-amd64.tar.gz',
    },
    category: 'runtime',
  },
  rust: {
    purpose: 'Rust programming language compiler. Required for compiling Rust-based applications.',
    checkCommand: 'rustc --version',
    installCommands: {
      darwin: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
      linux: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
    },
    category: 'runtime',
  },
  pnpm: {
    purpose: 'Fast and disk-efficient package manager for Node.js. Required when the project uses pnpm-lock.yaml.',
    checkCommand: 'pnpm --version',
    installCommands: {
      darwin: 'corepack enable && corepack prepare pnpm@latest --activate',
      linux: 'corepack enable && corepack prepare pnpm@latest --activate',
    },
    category: 'package_manager',
  },
  yarn: {
    purpose: 'Alternative Node.js package manager. Required when the project uses yarn.lock.',
    checkCommand: 'yarn --version',
    installCommands: {
      darwin: 'corepack enable && corepack prepare yarn@stable --activate',
      linux: 'corepack enable && corepack prepare yarn@stable --activate',
    },
    category: 'package_manager',
  },
  poetry: {
    purpose: 'Python dependency management tool. Required when the project uses poetry.lock for dependency resolution.',
    checkCommand: 'poetry --version',
    installCommands: {
      darwin: 'pip3 install poetry',
      linux: 'pip3 install poetry',
    },
    category: 'package_manager',
  },
  ffmpeg: {
    purpose: 'High-performance multimedia framework for video/audio processing, transcoding, screen recording, and streaming.',
    checkCommand: 'ffmpeg -version',
    installCommands: {
      darwin: 'brew install ffmpeg',
      linux: 'sudo apt-get install -y ffmpeg',
    },
    category: 'system_lib',
  },
  git: {
    purpose: 'Version control system for cloning and managing source code repositories.',
    checkCommand: 'git --version',
    installCommands: {
      darwin: 'brew install git',
      linux: 'sudo apt-get install -y git',
    },
    category: 'build_tool',
  },
  caddy: {
    purpose: 'Production-grade reverse proxy with automatic HTTPS. Routes incoming traffic to deployed application containers.',
    checkCommand: 'caddy version',
    installCommands: {
      darwin: 'brew install caddy',
      linux: 'sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https && curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && sudo apt update && sudo apt install -y caddy',
    },
    category: 'system_lib',
  },
  chromium: {
    purpose: 'Headless browser binary required by Puppeteer for web scraping, PDF generation, or screenshot automation.',
    checkCommand: 'chromium --version || chromium-browser --version',
    installCommands: {
      darwin: 'brew install --cask chromium',
      linux: 'sudo apt-get install -y chromium-browser',
    },
    category: 'system_lib',
  },
  imagemagick: {
    purpose: 'Image processing toolkit for resizing, converting, and manipulating image files.',
    checkCommand: 'convert --version || magick --version',
    installCommands: {
      darwin: 'brew install imagemagick',
      linux: 'sudo apt-get install -y imagemagick',
    },
    category: 'system_lib',
  },
};

export class AIDependencyManager {
  /**
   * Analyze the AI Task Plan and determine which system dependencies are needed.
   */
  async analyzeDependencies(
    taskPlan: AITaskPlan,
    deploymentId?: string
  ): Promise<DependencyCheck[]> {
    const checks: DependencyCheck[] = [];
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';

    // Runtime dependency
    const runtimeMap: Record<string, string> = {
      node: 'node',
      python: 'python3',
      go: 'go',
      rust: 'rust',
      ruby: 'ruby',
    };

    const runtimeDep = runtimeMap[taskPlan.runtime];
    if (runtimeDep && DEPENDENCY_CATALOG[runtimeDep]) {
      const cat = DEPENDENCY_CATALOG[runtimeDep];
      const installed = await this.checkInstalled(cat.checkCommand);
      checks.push({
        name: runtimeDep,
        purpose: cat.purpose,
        installCommand: cat.installCommands[platform],
        checkCommand: cat.checkCommand,
        installed: installed.available,
        version: installed.version,
        required: true,
        category: cat.category,
      });
    }

    // Package manager dependency
    if (taskPlan.packageManager !== 'npm' && DEPENDENCY_CATALOG[taskPlan.packageManager]) {
      const cat = DEPENDENCY_CATALOG[taskPlan.packageManager];
      const installed = await this.checkInstalled(cat.checkCommand);
      checks.push({
        name: taskPlan.packageManager,
        purpose: cat.purpose,
        installCommand: cat.installCommands[platform],
        checkCommand: cat.checkCommand,
        installed: installed.available,
        version: installed.version,
        required: true,
        category: cat.category,
      });
    }

    // System-level dependencies from AI Task Plan
    for (const dep of taskPlan.systemDependencies) {
      const depName = dep.toLowerCase().trim();
      if (DEPENDENCY_CATALOG[depName]) {
        const cat = DEPENDENCY_CATALOG[depName];
        const installed = await this.checkInstalled(cat.checkCommand);
        checks.push({
          name: depName,
          purpose: cat.purpose,
          installCommand: cat.installCommands[platform],
          checkCommand: cat.checkCommand,
          installed: installed.available,
          version: installed.version,
          required: false,
          category: cat.category,
        });
      }
    }

    // Always check git
    const gitCat = DEPENDENCY_CATALOG.git;
    const gitInstalled = await this.checkInstalled(gitCat.checkCommand);
    if (!gitInstalled.available) {
      checks.push({
        name: 'git',
        purpose: gitCat.purpose,
        installCommand: gitCat.installCommands[platform],
        checkCommand: gitCat.checkCommand,
        installed: false,
        required: true,
        category: 'build_tool',
      });
    }

    if (deploymentId) {
      const missing = checks.filter(c => !c.installed);
      if (missing.length > 0) {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'warn',
          stage: 'dependency',
          message: `[AI Dependency Manager] ${missing.length} missing dependencies detected: ${missing.map(m => m.name).join(', ')}`,
        });
      } else {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'info',
          stage: 'dependency',
          message: `[AI Dependency Manager] All ${checks.length} dependencies verified as installed`,
        });
      }
    }

    return checks;
  }

  /**
   * Install missing dependencies based on access mode (ASK vs AUTO).
   * Returns the list of dependencies that need user approval in ASK mode,
   * or installs them directly in AUTO mode.
   */
  private currentMode: 'ASK' | 'AUTO' = 'ASK';

  setMode(mode: 'ASK' | 'AUTO'): void {
    this.currentMode = mode;
    settingsService.setAccessMode(mode).catch(() => {});
  }

  getMode(): 'ASK' | 'AUTO' {
    return this.currentMode;
  }

  async approveDependency(name: string, dep?: DependencyCheck): Promise<DependencyInstallResult> {
    const dependencyToInstall: DependencyCheck = dep || {
      name,
      purpose: this.explainDependency(name),
      installCommand: DEPENDENCY_CATALOG[name.toLowerCase()]?.installCommands[process.platform === 'darwin' ? 'darwin' : 'linux'] || `brew install ${name}`,
      checkCommand: DEPENDENCY_CATALOG[name.toLowerCase()]?.checkCommand || `${name} --version`,
      installed: false,
      required: true,
      category: 'system_lib',
    };
    return this.installDependency(dependencyToInstall);
  }

  /**
   * Install missing dependencies based on access mode (ASK vs AUTO).
   * Returns the list of dependencies that need user approval in ASK mode,
   * or installs them directly in AUTO mode.
   */
  async installMissingDependencies(
    checks: DependencyCheck[],
    deploymentId?: string
  ): Promise<{
    installed: DependencyInstallResult[];
    pendingApproval: DependencyCheck[];
  }> {
    const accessMode = this.currentMode;
    const missing = checks.filter(c => !c.installed);

    if (missing.length === 0) {
      return { installed: [], pendingApproval: [] };
    }

    if (accessMode === 'AUTO') {
      // Auto mode: install everything without asking
      const results: DependencyInstallResult[] = [];
      for (const dep of missing) {
        if (deploymentId) {
          eventBus.emitLog({
            deploymentId,
            timestamp: Date.now(),
            level: 'info',
            stage: 'dependency',
            message: `[AI Dependency Manager][AUTO] Installing ${dep.name}: ${dep.purpose}`,
          });
        }

        const result = await this.installDependency(dep);
        results.push(result);

        if (deploymentId) {
          eventBus.emitLog({
            deploymentId,
            timestamp: Date.now(),
            level: result.installed ? 'info' : 'error',
            stage: 'dependency',
            message: result.installed
              ? `[AI Dependency Manager] Successfully installed ${dep.name}`
              : `[AI Dependency Manager] Failed to install ${dep.name}: ${result.error}`,
          });
        }
      }
      return { installed: results, pendingApproval: [] };
    }

    // ASK mode: return pending approvals for the UI to present
    if (deploymentId) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'dependency',
        message: `[AI Dependency Manager][ASK] ${missing.length} dependencies require user approval before installation`,
      });
    }

    return { installed: [], pendingApproval: missing };
  }

  /**
   * Install a single dependency on the host system.
   */
  async installDependency(dep: DependencyCheck): Promise<DependencyInstallResult> {
    return new Promise((resolve) => {
      const parts = dep.installCommand.split(/\s+/);
      const proc = spawn(parts[0], parts.slice(1), {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
          NONINTERACTIVE: '1',
          DEBIAN_FRONTEND: 'noninteractive',
        },
      });

      let output = '';
      proc.stdout?.on('data', (chunk) => { output += chunk.toString(); });
      proc.stderr?.on('data', (chunk) => { output += chunk.toString(); });

      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({
          name: dep.name,
          installed: false,
          error: 'Installation timed out after 5 minutes',
          output: output.slice(-2000),
        });
      }, 300000); // 5 minute timeout

      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve({
          name: dep.name,
          installed: code === 0,
          output: output.slice(-2000),
          error: code !== 0 ? `Install exited with code ${code}` : undefined,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          name: dep.name,
          installed: false,
          error: err.message,
        });
      });
    });
  }

  /**
   * Check if a command/tool is available on the system.
   */
  private async checkInstalled(checkCommand: string): Promise<{ available: boolean; version?: string }> {
    return new Promise((resolve) => {
      const proc = spawn(checkCommand.split(' ')[0], checkCommand.split(' ').slice(1), {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
        },
      });

      let output = '';
      proc.stdout?.on('data', (chunk) => { output += chunk.toString(); });
      proc.stderr?.on('data', (chunk) => { output += chunk.toString(); });

      const timeout = setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        resolve({ available: false });
      }, 5000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        const versionMatch = output.match(/(\d+\.\d+[\.\d]*)/);
        resolve({
          available: code === 0,
          version: versionMatch ? versionMatch[1] : undefined,
        });
      });

      proc.on('error', () => {
        clearTimeout(timeout);
        resolve({ available: false });
      });
    });
  }

  /**
   * Get a user-friendly explanation of a dependency.
   */
  explainDependency(name: string): string {
    const cat = DEPENDENCY_CATALOG[name.toLowerCase()];
    if (!cat) return `${name}: A system dependency required by the project.`;
    return `**${name}** — ${cat.purpose}`;
  }
}

export const aiDependencyManager = new AIDependencyManager();
