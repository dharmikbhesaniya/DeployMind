/**
 * AI Task Engine - Dynamic Command Reasoning for Any Application Type
 *
 * Instead of hardcoded static logic (e.g., "if Node → npm start"),
 * this engine inspects the actual repository structure, manifest files,
 * configuration, and documentation to dynamically reason about what
 * commands to execute for install, build, start, test, and migrations.
 *
 * This is the core of "AI manages deployment, not prebuilt functions."
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';
import { eventBus } from '../../core/events.js';

export interface AITaskPlan {
  /** Detected runtime/language environment */
  runtime: string;
  /** Detected package manager (npm, yarn, pnpm, pip, cargo, go, etc.) */
  packageManager: string;
  /** Command to install dependencies */
  installCommand: string | null;
  /** Command to build production assets */
  buildCommand: string | null;
  /** Command to start the production application */
  startCommand: string | null;
  /** Command to run tests */
  testCommand: string | null;
  /** Command to run database migrations */
  migrationCommand: string | null;
  /** Command to run linting or code quality checks */
  lintCommand: string | null;
  /** Detected application port */
  port: number;
  /** Whether the app is a static site (SPA) */
  isStaticSite: boolean;
  /** Whether the app is a desktop/electron app */
  isDesktopApp: boolean;
  /** Whether the app needs a custom production server for serving static files */
  needsStaticServer: boolean;
  /** Required system-level dependencies (ffmpeg, imagemagick, etc.) */
  systemDependencies: string[];
  /** Environment variables that must be set for production */
  requiredEnvVars: string[];
  /** Desktop framework if desktop app (electron, tauri, neutralino) */
  desktopFramework?: string;
  /** Warning notices or constraints identified */
  warnings?: string[];
  /** AI confidence score */
  confidence: number;
  /** Reasoning trace explaining each decision */
  reasoning: string[];
}

export interface RepoInspection {
  /** Files at the root of the repository */
  rootFiles: string[];
  /** Content of package.json if exists */
  packageJson?: any;
  /** Content of requirements.txt if exists */
  requirementsTxt?: string;
  /** Content of pyproject.toml if exists */
  pyprojectToml?: string;
  /** Content of go.mod if exists */
  goMod?: string;
  /** Content of Cargo.toml if exists */
  cargoToml?: string;
  /** Content of Gemfile if exists */
  gemfile?: string;
  /** Content of Makefile if exists */
  makefile?: string;
  /** Content of Dockerfile if exists */
  dockerfile?: string;
  /** Content of docker-compose.yml if exists */
  composeFile?: string;
  /** Content of README.md first 3000 chars */
  readme?: string;
  /** Content of Procfile if exists */
  procfile?: string;
  /** Content of .tool-versions if exists */
  toolVersions?: string;
  /** Whether specific lockfiles exist */
  lockfiles: {
    packageLock: boolean;
    yarnLock: boolean;
    pnpmLock: boolean;
    poetryLock: boolean;
    pipfileLock: boolean;
    goSum: boolean;
    cargoLock: boolean;
    gemfileLock: boolean;
  };
  /** Subdirectories present */
  directories: string[];
  /** Detected config files */
  configFiles: string[];
}

export class AITaskEngine {
  /**
   * Deeply inspects a repository directory and extracts all relevant metadata
   * for AI reasoning about deployment commands.
   */
  inspectRepository(sourceDir: string): RepoInspection {
    if (!fs.existsSync(sourceDir)) {
      return {
        rootFiles: [],
        lockfiles: {
          packageLock: false, yarnLock: false, pnpmLock: false,
          poetryLock: false, pipfileLock: false, goSum: false,
          cargoLock: false, gemfileLock: false,
        },
        directories: [],
        configFiles: [],
      };
    }

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    const rootFiles = entries.filter(e => !e.isDirectory()).map(e => e.name);
    const directories = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

    const safeRead = (filename: string, maxBytes = 5000): string | undefined => {
      const filePath = path.join(sourceDir, filename);
      if (!fs.existsSync(filePath)) return undefined;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        return content.slice(0, maxBytes);
      } catch {
        return undefined;
      }
    };

    const safeJson = (filename: string): any | undefined => {
      const content = safeRead(filename, 50000);
      if (!content) return undefined;
      try {
        return JSON.parse(content);
      } catch {
        return undefined;
      }
    };

    // Detect config files
    const configFilePatterns = [
      'vite.config.ts', 'vite.config.js', 'vite.config.mjs',
      'next.config.js', 'next.config.mjs', 'next.config.ts',
      'nuxt.config.ts', 'nuxt.config.js',
      'svelte.config.js', 'svelte.config.ts',
      'astro.config.mjs', 'astro.config.ts',
      'remix.config.js', 'remix.config.ts',
      'angular.json', 'tsconfig.json',
      'webpack.config.js', 'webpack.config.ts',
      'rollup.config.js', 'rollup.config.ts',
      'turbo.json', 'lerna.json', 'nx.json',
      'nest-cli.json', 'vercel.json', 'netlify.toml',
      'fly.toml', 'railway.toml',
      'tox.ini', 'setup.py', 'setup.cfg',
      'alembic.ini', 'manage.py',
      'Rakefile', 'Gruntfile.js', 'gulpfile.js',
      '.babelrc', 'babel.config.js',
      'tailwind.config.js', 'tailwind.config.ts',
      'postcss.config.js', 'postcss.config.cjs',
      'drizzle.config.ts', 'prisma',
    ];

    const configFiles = configFilePatterns.filter(cf => {
      const p = path.join(sourceDir, cf);
      return fs.existsSync(p);
    });

    // Also check for prisma directory
    if (fs.existsSync(path.join(sourceDir, 'prisma', 'schema.prisma'))) {
      configFiles.push('prisma/schema.prisma');
    }

    return {
      rootFiles,
      packageJson: safeJson('package.json'),
      requirementsTxt: safeRead('requirements.txt'),
      pyprojectToml: safeRead('pyproject.toml'),
      goMod: safeRead('go.mod'),
      cargoToml: safeRead('Cargo.toml'),
      gemfile: safeRead('Gemfile'),
      makefile: safeRead('Makefile', 3000),
      dockerfile: safeRead('Dockerfile'),
      composeFile: safeRead('docker-compose.yml') || safeRead('docker-compose.yaml') || safeRead('compose.yml'),
      readme: safeRead('README.md', 3000) || safeRead('readme.md', 3000),
      procfile: safeRead('Procfile'),
      toolVersions: safeRead('.tool-versions'),
      lockfiles: {
        packageLock: fs.existsSync(path.join(sourceDir, 'package-lock.json')),
        yarnLock: fs.existsSync(path.join(sourceDir, 'yarn.lock')),
        pnpmLock: fs.existsSync(path.join(sourceDir, 'pnpm-lock.yaml')),
        poetryLock: fs.existsSync(path.join(sourceDir, 'poetry.lock')),
        pipfileLock: fs.existsSync(path.join(sourceDir, 'Pipfile.lock')),
        goSum: fs.existsSync(path.join(sourceDir, 'go.sum')),
        cargoLock: fs.existsSync(path.join(sourceDir, 'Cargo.lock')),
        gemfileLock: fs.existsSync(path.join(sourceDir, 'Gemfile.lock')),
      },
      directories,
      configFiles,
    };
  }

  /**
   * Main entry: Synthesize the full AI Task Plan for a repository.
   * Uses LLM if available, falls back to intelligent local heuristic engine.
   */
  async synthesizeTaskPlan(sourceDir: string, deploymentId?: string): Promise<AITaskPlan> {
    const inspection = this.inspectRepository(sourceDir);

    // Attempt LLM-powered reasoning first
    if (config.ai.apiKey) {
      try {
        const llmPlan = await this.queryLLMForTaskPlan(inspection, deploymentId);
        if (llmPlan) return llmPlan;
      } catch (err) {
        if (deploymentId) {
          eventBus.emitLog({
            deploymentId,
            timestamp: Date.now(),
            level: 'warn',
            stage: 'plan',
            message: `[AI Task Engine] LLM reasoning unavailable, using local heuristic engine: ${(err as Error).message}`,
          });
        }
      }
    }

    // Local intelligent heuristic engine
    return this.synthesizeLocalPlan(inspection, deploymentId);
  }

  /**
   * Local heuristic-based reasoning engine.
   * Inspects actual file contents to make intelligent decisions rather than
   * relying on simple "if Node → npm start" logic.
   */
  private synthesizeLocalPlan(inspection: RepoInspection, deploymentId?: string): AITaskPlan {
    const reasoning: string[] = [];
    const systemDependencies: string[] = [];
    const requiredEnvVars: string[] = [];

    // 1. DETECT RUNTIME & PACKAGE MANAGER
    let runtime = 'unknown';
    let packageManager = 'unknown';

    if (inspection.packageJson) {
      runtime = 'node';
      if (inspection.lockfiles.pnpmLock) {
        packageManager = 'pnpm';
        reasoning.push('Detected pnpm-lock.yaml → using pnpm as package manager');
      } else if (inspection.lockfiles.yarnLock) {
        packageManager = 'yarn';
        reasoning.push('Detected yarn.lock → using yarn as package manager');
      } else {
        packageManager = 'npm';
        reasoning.push('Detected package.json with package-lock.json or no lockfile → using npm');
      }
    } else if (inspection.pyprojectToml || inspection.requirementsTxt) {
      runtime = 'python';
      systemDependencies.push('python3');
      if (inspection.lockfiles.poetryLock) {
        packageManager = 'poetry';
        systemDependencies.push('poetry');
        reasoning.push('Detected poetry.lock → using poetry');
      } else if (inspection.lockfiles.pipfileLock) {
        packageManager = 'pipenv';
        systemDependencies.push('pipenv');
        reasoning.push('Detected Pipfile.lock → using pipenv');
      } else {
        packageManager = 'pip';
        reasoning.push('Detected requirements.txt → using pip');
      }
    } else if (inspection.goMod) {
      runtime = 'go';
      packageManager = 'go';
      systemDependencies.push('go');
      reasoning.push('Detected go.mod → Go runtime');
    } else if (inspection.cargoToml) {
      runtime = 'rust';
      packageManager = 'cargo';
      systemDependencies.push('rust', 'cargo');
      reasoning.push('Detected Cargo.toml → Rust runtime');
    } else if (inspection.gemfile) {
      runtime = 'ruby';
      packageManager = 'bundler';
      systemDependencies.push('ruby');
      reasoning.push('Detected Gemfile → Ruby runtime with Bundler');
    } else {
      reasoning.push('No recognizable manifest file found → defaulting to generic runtime');
    }

    // 2. DETECT FRAMEWORK & APPLICATION TYPE
    let isStaticSite = false;
    let isDesktopApp = false;
    let needsStaticServer = false;
    let detectedFramework = 'generic';
    let port = 3000;

    if (inspection.packageJson) {
      const pkg = inspection.packageJson;
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Desktop app detection
      if (allDeps.electron || allDeps['electron-builder'] || allDeps['electron-forge']) {
        isDesktopApp = true;
        detectedFramework = 'electron';
        reasoning.push('Detected Electron dependency → desktop app, will serve web UI portion only');
      }

      // Framework detection with port inference
      if (allDeps.next) {
        detectedFramework = 'nextjs';
        port = 3000;
        reasoning.push('Detected Next.js → default port 3000, uses `next start` for production');
      } else if (allDeps.nuxt || allDeps['nuxt3']) {
        detectedFramework = 'nuxt';
        port = 3000;
        reasoning.push('Detected Nuxt.js → default port 3000');
      } else if (allDeps['@sveltejs/kit']) {
        detectedFramework = 'sveltekit';
        port = 3000;
        reasoning.push('Detected SvelteKit → default port 3000');
      } else if (allDeps.astro) {
        detectedFramework = 'astro';
        port = 4321;
        reasoning.push('Detected Astro → default port 4321');
      } else if (allDeps.remix || allDeps['@remix-run/node']) {
        detectedFramework = 'remix';
        port = 3000;
        reasoning.push('Detected Remix → default port 3000');
      } else if (allDeps.vite && (allDeps.react || allDeps.vue || allDeps.svelte)) {
        isStaticSite = true;
        detectedFramework = 'vite-spa';
        port = 4173; // vite preview default
        reasoning.push('Detected Vite SPA (React/Vue/Svelte) → static site, needs production server');
      } else if (allDeps['react-scripts']) {
        isStaticSite = true;
        detectedFramework = 'cra';
        reasoning.push('Detected Create React App → static site after build');
      } else if (allDeps['@angular/core']) {
        isStaticSite = true;
        detectedFramework = 'angular';
        reasoning.push('Detected Angular → static site after build');
      } else if (allDeps.express || allDeps.fastify || allDeps.koa || allDeps.hapi || allDeps['@hapi/hapi']) {
        detectedFramework = allDeps.express ? 'express' : allDeps.fastify ? 'fastify' : 'node-server';
        port = 3000;
        reasoning.push(`Detected ${detectedFramework} server framework → API/backend app`);
      } else if (allDeps['@nestjs/core']) {
        detectedFramework = 'nestjs';
        port = 3000;
        reasoning.push('Detected NestJS → default port 3000');
      }

      // Check for specific port in scripts or main
      if (pkg.scripts) {
        for (const [, script] of Object.entries(pkg.scripts)) {
          const portMatch = (script as string).match(/(?:--port|PORT=|:)\s*(\d{4,5})/);
          if (portMatch) {
            port = parseInt(portMatch[1], 10);
            reasoning.push(`Detected port ${port} from package.json scripts`);
            break;
          }
        }
      }

      // System dependency detection from package contents
      if (allDeps.sharp || allDeps.canvas) {
        systemDependencies.push('libvips', 'libcairo');
        reasoning.push('Detected sharp/canvas → requires libvips/libcairo system libs');
      }
      if (allDeps.ffmpeg || allDeps['fluent-ffmpeg'] || allDeps['ffmpeg-static']) {
        systemDependencies.push('ffmpeg');
        reasoning.push('Detected ffmpeg dependency → requires ffmpeg binary');
      }
      if (allDeps.puppeteer && !allDeps['puppeteer-core']) {
        systemDependencies.push('chromium');
        reasoning.push('Detected puppeteer (not core) → requires Chromium binary');
      }
    }

    // Python framework detection
    if (runtime === 'python') {
      const allPythonDeps = (inspection.requirementsTxt || '') + (inspection.pyprojectToml || '');
      if (allPythonDeps.includes('django')) {
        detectedFramework = 'django';
        port = 8000;
        reasoning.push('Detected Django → default port 8000');
      } else if (allPythonDeps.includes('flask')) {
        detectedFramework = 'flask';
        port = 5000;
        reasoning.push('Detected Flask → default port 5000');
      } else if (allPythonDeps.includes('fastapi') || allPythonDeps.includes('uvicorn')) {
        detectedFramework = 'fastapi';
        port = 8000;
        reasoning.push('Detected FastAPI/Uvicorn → default port 8000');
      } else if (allPythonDeps.includes('streamlit')) {
        detectedFramework = 'streamlit';
        port = 8501;
        reasoning.push('Detected Streamlit → default port 8501');
      }
    }

    // Go framework detection
    if (runtime === 'go') {
      const goMod = inspection.goMod || '';
      if (goMod.includes('gin-gonic')) {
        detectedFramework = 'gin';
        port = 8080;
        reasoning.push('Detected Gin framework → default port 8080');
      } else if (goMod.includes('gorilla/mux') || goMod.includes('chi') || goMod.includes('fiber')) {
        detectedFramework = 'go-http';
        port = 8080;
        reasoning.push('Detected Go HTTP framework → default port 8080');
      } else {
        port = 8080;
      }
    }

    // Rust port detection
    if (runtime === 'rust') {
      port = 8080;
      const cargoContent = inspection.cargoToml || '';
      if (cargoContent.includes('actix-web')) {
        detectedFramework = 'actix';
        reasoning.push('Detected Actix-web → default port 8080');
      } else if (cargoContent.includes('rocket')) {
        detectedFramework = 'rocket';
        reasoning.push('Detected Rocket → default port 8000');
        port = 8000;
      }
    }

    // Procfile overrides
    if (inspection.procfile) {
      reasoning.push('Detected Procfile → will use Procfile web entry for start command');
    }

    // 3. SYNTHESIZE COMMANDS
    let installCommand: string | null = null;
    let buildCommand: string | null = null;
    let startCommand: string | null = null;
    let testCommand: string | null = null;
    let migrationCommand: string | null = null;
    let lintCommand: string | null = null;

    // --- Node.js ---
    if (runtime === 'node' && inspection.packageJson) {
      const pkg = inspection.packageJson;
      const scripts = pkg.scripts || {};

      // Install command based on package manager
      switch (packageManager) {
        case 'pnpm':
          installCommand = 'pnpm install --frozen-lockfile';
          break;
        case 'yarn':
          installCommand = 'yarn install --frozen-lockfile';
          break;
        default:
          installCommand = inspection.lockfiles.packageLock
            ? 'npm ci --prefer-offline'
            : 'npm install --prefer-offline';
      }
      reasoning.push(`Install command: ${installCommand}`);

      // Build command: check actual scripts
      if (scripts['build:production']) {
        buildCommand = `${packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm run'} build:production`;
        reasoning.push('Using build:production script from package.json');
      } else if (scripts['build:prod']) {
        buildCommand = `${packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm run'} build:prod`;
        reasoning.push('Using build:prod script from package.json');
      } else if (scripts.build && !isDesktopApp) {
        const runCmd = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm';
        buildCommand = `${runCmd} run build`;
        reasoning.push('Using build script from package.json');
      } else if (isDesktopApp && scripts['build:web']) {
        const runCmd = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm';
        buildCommand = `${runCmd} run build:web`;
        reasoning.push('Desktop app detected → using build:web script to build web portion only');
      }

      // Start command: intelligent ordering of script priority
      if (inspection.procfile) {
        const webLine = inspection.procfile.split('\n').find(l => l.startsWith('web:'));
        if (webLine) {
          startCommand = webLine.replace('web:', '').trim();
          reasoning.push(`Start command from Procfile: ${startCommand}`);
        }
      }

      if (!startCommand) {
        // Priority order for production start
        const startPriority = [
          'start:prod', 'start:production', 'serve', 'start', 'preview',
        ];

        for (const s of startPriority) {
          if (scripts[s]) {
            const runCmd = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm';
            // Verify it's not a dev-mode command
            const scriptContent = (scripts[s] as string).toLowerCase();
            const isDevMode = scriptContent.includes('nodemon') || scriptContent.includes('ts-node-dev') ||
              (scriptContent.includes('--dev') && !scriptContent.includes('--dev-port'));
            if (!isDevMode || s === 'start') {
              startCommand = `${runCmd} run ${s}`;
              reasoning.push(`Start command: ${startCommand} (from script "${s}": ${scripts[s]})`);
              break;
            }
          }
        }

        // Fallback: check for main entry point
        if (!startCommand) {
          if (pkg.main && fs.existsSync(path.join(path.resolve(inspection.rootFiles.length > 0 ? '.' : '.'), pkg.main))) {
            startCommand = `node ${pkg.main}`;
            reasoning.push(`Start command: node ${pkg.main} (from package.json main field)`);
          } else if (scripts.start) {
            const runCmd = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm';
            startCommand = `${runCmd} start`;
            reasoning.push('Start command: npm start (fallback to start script)');
          }
        }
      }

      // Static site: needs a production static server
      if (isStaticSite && buildCommand) {
        needsStaticServer = true;
        reasoning.push('Static SPA detected → will generate a production-grade static server after build');
      }

      // Test command
      if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
        const runCmd = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm';
        testCommand = `${runCmd} test`;
        reasoning.push(`Test command: ${testCommand}`);
      } else if (scripts['test:ci']) {
        const runCmd = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm';
        testCommand = `${runCmd} run test:ci`;
        reasoning.push(`Test command: ${testCommand} (CI variant)`);
      }

      // Migration command detection
      if (scripts['db:migrate'] || scripts.migrate) {
        const migrateScript = scripts['db:migrate'] ? 'db:migrate' : 'migrate';
        const runCmd = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm';
        migrationCommand = `${runCmd} run ${migrateScript}`;
        reasoning.push(`Migration command: ${migrationCommand}`);
      } else if (inspection.configFiles.includes('prisma/schema.prisma')) {
        migrationCommand = 'npx prisma migrate deploy';
        reasoning.push('Detected Prisma schema → migration: npx prisma migrate deploy');
      } else if (inspection.configFiles.includes('drizzle.config.ts')) {
        migrationCommand = 'npx drizzle-kit push';
        reasoning.push('Detected Drizzle config → migration: npx drizzle-kit push');
      }

      // Lint command
      if (scripts.lint) {
        const runCmd = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm';
        lintCommand = `${runCmd} run lint`;
      }

      // Required env vars from package.json engine constraints or known patterns
      if (pkg.engines?.node) {
        reasoning.push(`Node engine constraint: ${pkg.engines.node}`);
      }
    }

    // --- Python ---
    if (runtime === 'python') {
      // Install
      switch (packageManager) {
        case 'poetry':
          installCommand = 'poetry install --no-interaction --no-ansi';
          break;
        case 'pipenv':
          installCommand = 'pipenv install --deploy';
          break;
        default:
          if (inspection.requirementsTxt) {
            installCommand = 'pip install --no-cache-dir -r requirements.txt';
          } else if (inspection.pyprojectToml) {
            installCommand = 'pip install --no-cache-dir .';
          }
      }

      // Start command
      if (inspection.procfile) {
        const webLine = inspection.procfile.split('\n').find(l => l.startsWith('web:'));
        if (webLine) {
          startCommand = webLine.replace('web:', '').trim();
          reasoning.push(`Python start from Procfile: ${startCommand}`);
        }
      }

      if (!startCommand) {
        if (detectedFramework === 'django') {
          startCommand = `gunicorn --bind 0.0.0.0:${port} --workers 4 config.wsgi:application`;
          reasoning.push('Django → using gunicorn with 4 workers');
          if (inspection.configFiles.includes('manage.py')) {
            migrationCommand = 'python manage.py migrate --noinput';
          }
        } else if (detectedFramework === 'fastapi') {
          startCommand = `uvicorn main:app --host 0.0.0.0 --port ${port}`;
          // Check for app.py as alternative entrypoint
          if (inspection.rootFiles.includes('app.py') && !inspection.rootFiles.includes('main.py')) {
            startCommand = `uvicorn app:app --host 0.0.0.0 --port ${port}`;
          }
          reasoning.push(`FastAPI → using uvicorn on port ${port}`);
        } else if (detectedFramework === 'flask') {
          startCommand = `gunicorn --bind 0.0.0.0:${port} app:app`;
          if (inspection.rootFiles.includes('wsgi.py')) {
            startCommand = `gunicorn --bind 0.0.0.0:${port} wsgi:app`;
          }
          reasoning.push('Flask → using gunicorn');
        } else if (detectedFramework === 'streamlit') {
          startCommand = `streamlit run app.py --server.port ${port} --server.address 0.0.0.0`;
          reasoning.push('Streamlit → using streamlit run');
        } else {
          // Generic Python
          if (inspection.rootFiles.includes('app.py')) {
            startCommand = 'python app.py';
          } else if (inspection.rootFiles.includes('main.py')) {
            startCommand = 'python main.py';
          } else if (inspection.rootFiles.includes('server.py')) {
            startCommand = 'python server.py';
          } else if (inspection.rootFiles.includes('run.py')) {
            startCommand = 'python run.py';
          }
        }
      }

      // Python tests
      if (inspection.rootFiles.includes('pytest.ini') || inspection.rootFiles.includes('conftest.py') ||
          inspection.directories.includes('tests') || inspection.directories.includes('test')) {
        testCommand = 'pytest';
        reasoning.push('Detected pytest configuration → test command: pytest');
      }

      // Alembic migrations
      if (inspection.configFiles.includes('alembic.ini') || inspection.directories.includes('alembic')) {
        migrationCommand = 'alembic upgrade head';
        reasoning.push('Detected Alembic → migration: alembic upgrade head');
      }
    }

    // --- Go ---
    if (runtime === 'go') {
      installCommand = 'go mod download';
      buildCommand = 'go build -o app .';
      startCommand = './app';
      testCommand = 'go test ./...';
      reasoning.push('Go → build binary and run directly');
    }

    // --- Rust ---
    if (runtime === 'rust') {
      installCommand = 'cargo fetch';
      buildCommand = 'cargo build --release';
      startCommand = './target/release/' + (inspection.cargoToml?.match(/name\s*=\s*"([^"]+)"/)?.[1] || 'app');
      testCommand = 'cargo test';
      reasoning.push('Rust → cargo build --release');
    }

    // --- Ruby ---
    if (runtime === 'ruby') {
      installCommand = 'bundle install --deployment --without development test';
      if (inspection.rootFiles.includes('Rakefile') && inspection.rootFiles.includes('config.ru')) {
        detectedFramework = 'rails';
        startCommand = 'bundle exec rails server -b 0.0.0.0 -p 3000';
        migrationCommand = 'bundle exec rails db:migrate';
        testCommand = 'bundle exec rails test';
        port = 3000;
        reasoning.push('Detected Rails → using rails server');
      } else if (inspection.rootFiles.includes('config.ru')) {
        startCommand = 'bundle exec rackup -o 0.0.0.0 -p 9292';
        port = 9292;
        reasoning.push('Detected Rack app → using rackup');
      }
    }

    // --- Makefile overrides ---
    if (inspection.makefile) {
      const makeContent = inspection.makefile;
      if (makeContent.includes('run:') || makeContent.includes('serve:')) {
        reasoning.push('Makefile detected with run/serve target → can use `make run` or `make serve`');
      }
      if (makeContent.includes('build:')) {
        reasoning.push('Makefile detected with build target → can use `make build`');
      }
    }

    // Port override from README
    if (inspection.readme) {
      const portMatch = inspection.readme.match(/(?:port|PORT)\s*[:=]\s*(\d{4,5})/);
      if (portMatch) {
        const readmePort = parseInt(portMatch[1], 10);
        if (readmePort > 1024 && readmePort < 65535) {
          reasoning.push(`README mentions port ${readmePort} → overriding default`);
          port = readmePort;
        }
      }
    }

    // Calculate confidence
    let confidence = 0.5;
    if (runtime !== 'unknown') confidence += 0.15;
    if (installCommand) confidence += 0.1;
    if (startCommand) confidence += 0.15;
    if (buildCommand) confidence += 0.05;
    if (detectedFramework !== 'generic') confidence += 0.05;
    confidence = Math.min(confidence, 0.98);

    const warnings: string[] = [];
    if (isDesktopApp) {
      warnings.push(`Desktop GUI application detected (${detectedFramework}). Server runtime will serve web UI or build output.`);
    }

    const plan: AITaskPlan = {
      runtime,
      packageManager,
      installCommand,
      buildCommand: isDesktopApp && !buildCommand ? null : buildCommand,
      startCommand,
      testCommand,
      migrationCommand,
      lintCommand,
      port,
      isStaticSite,
      isDesktopApp,
      desktopFramework: isDesktopApp ? detectedFramework : undefined,
      warnings,
      needsStaticServer,
      systemDependencies,
      requiredEnvVars,
      confidence,
      reasoning,
    };

    if (deploymentId) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'plan',
        message: `[AI Task Engine] Synthesized task plan: runtime=${runtime}, framework=${detectedFramework}, pkg=${packageManager}, port=${port}, confidence=${(confidence * 100).toFixed(0)}%`,
      });
      for (const r of reasoning.slice(0, 8)) {
        eventBus.emitLog({
          deploymentId,
          timestamp: Date.now(),
          level: 'info',
          stage: 'plan',
          message: `[AI Task Engine] Reasoning: ${r}`,
        });
      }
    }

    return plan;
  }

  /**
   * Query LLM for an intelligent task plan based on repository inspection.
   */
  private async queryLLMForTaskPlan(inspection: RepoInspection, deploymentId?: string): Promise<AITaskPlan | null> {
    const prompt = `You are an expert DevOps engineer. Analyze this repository metadata and determine the exact production deployment commands.

REPOSITORY STRUCTURE:
- Root files: ${inspection.rootFiles.join(', ')}
- Directories: ${inspection.directories.join(', ')}
- Config files: ${inspection.configFiles.join(', ')}
- Lockfiles: ${Object.entries(inspection.lockfiles).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}

${inspection.packageJson ? `PACKAGE.JSON SCRIPTS: ${JSON.stringify(inspection.packageJson.scripts || {})}
DEPENDENCIES: ${Object.keys(inspection.packageJson.dependencies || {}).join(', ')}
DEV DEPENDENCIES: ${Object.keys(inspection.packageJson.devDependencies || {}).join(', ')}` : ''}

${inspection.procfile ? `PROCFILE:\n${inspection.procfile}` : ''}
${inspection.makefile ? `MAKEFILE (first 1000 chars):\n${inspection.makefile.slice(0, 1000)}` : ''}
${inspection.readme ? `README (first 1000 chars):\n${inspection.readme.slice(0, 1000)}` : ''}

Return ONLY valid JSON:
{
  "runtime": "node|python|go|rust|ruby|unknown",
  "packageManager": "npm|yarn|pnpm|pip|poetry|pipenv|cargo|go|bundler",
  "installCommand": "string or null",
  "buildCommand": "string or null",
  "startCommand": "string or null",
  "testCommand": "string or null",
  "migrationCommand": "string or null",
  "lintCommand": "string or null",
  "port": number,
  "isStaticSite": boolean,
  "isDesktopApp": boolean,
  "needsStaticServer": boolean,
  "systemDependencies": ["string"],
  "requiredEnvVars": ["string"],
  "confidence": number (0-1),
  "reasoning": ["string explanation for each decision"]
}`;

    const res = await fetch(config.ai.openaiApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`LLM API error: ${res.statusText}`);
    const data = await res.json() as any;
    const parsed = JSON.parse(data.choices[0].message.content);

    if (deploymentId) {
      eventBus.emitLog({
        deploymentId,
        timestamp: Date.now(),
        level: 'info',
        stage: 'plan',
        message: `[AI Task Engine] LLM-powered task plan synthesized with ${(parsed.confidence * 100).toFixed(0)}% confidence`,
      });
    }

    return parsed as AITaskPlan;
  }
}

export const aiTaskEngine = new AITaskEngine();
