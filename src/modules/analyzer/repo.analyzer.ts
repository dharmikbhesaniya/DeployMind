import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { docParser, type ParsedDocSection } from '../doc-parser/doc.parser.js';
import { config } from '../../config/index.js';

const execFileAsync = promisify(execFile);

export interface RepoManifestSnapshot {
  repoUrl: string;
  commitHash?: string;
  hasDockerfile: boolean;
  dockerfileContent?: string;
  hasCompose: boolean;
  composeContent?: string;
  hasEnvExample: boolean;
  envExampleContent?: string;
  docSections: ParsedDocSection[];
  primaryRuntime?: string;
  detectedPorts: number[];
  detectedVariables: Array<{ key: string; rawValue?: string; comment?: string }>;
}

export class RepoAnalyzer {
  // Clones or accesses repository and extracts normalized manifest
  async analyzeRepository(repoUrl: string, branch = 'main'): Promise<RepoManifestSnapshot> {
    const tempDir = path.join(config.dataDir, 'clones', `repo_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    let commitHash = 'unknown';

    try {
      if (repoUrl.startsWith('http://') || repoUrl.startsWith('https://')) {
        // Shallow clone repository with depth 1
        await execFileAsync('git', ['clone', '--depth', '1', '--branch', branch, repoUrl, tempDir], {
          timeout: 60000,
        });
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: tempDir });
        commitHash = stdout.trim();
      } else if (fs.existsSync(repoUrl)) {
        // Local path
        return this.inspectDirectory(repoUrl, repoUrl, 'local');
      }

      const snapshot = this.inspectDirectory(tempDir, repoUrl, commitHash);
      return snapshot;
    } finally {
      // Clean up cloned files to conserve disk space
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Non-fatal
      }
    }
  }

  // Inspects a directory to extract metadata
  private inspectDirectory(dir: string, repoUrl: string, commitHash: string): RepoManifestSnapshot {
    let hasDockerfile = false;
    let dockerfileContent: string | undefined;
    let hasCompose = false;
    let composeContent: string | undefined;
    let hasEnvExample = false;
    let envExampleContent: string | undefined;
    let docSections: ParsedDocSection[] = [];
    let primaryRuntime: string | undefined;
    const detectedPorts: number[] = [];

    // Check Dockerfile
    const dockerfilePath = path.join(dir, 'Dockerfile');
    if (fs.existsSync(dockerfilePath)) {
      hasDockerfile = true;
      dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
      const exposeMatches = dockerfileContent.matchAll(/EXPOSE\s+(\d+)/gi);
      for (const m of exposeMatches) {
        detectedPorts.push(parseInt(m[1], 10));
      }
    }

    // Check Docker Compose
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const cf of composeFiles) {
      const cp = path.join(dir, cf);
      if (fs.existsSync(cp)) {
        hasCompose = true;
        composeContent = fs.readFileSync(cp, 'utf8');
        break;
      }
    }

    // Check Env Example
    const envFiles = ['.env.example', '.env.sample', '.env.template', 'env.example'];
    for (const ef of envFiles) {
      const ep = path.join(dir, ef);
      if (fs.existsSync(ep)) {
        hasEnvExample = true;
        envExampleContent = fs.readFileSync(ep, 'utf8');
        break;
      }
    }

    // Parse README
    const readmeFiles = ['README.md', 'readme.md', 'README', 'docs/README.md'];
    for (const rf of readmeFiles) {
      const rp = path.join(dir, rf);
      if (fs.existsSync(rp)) {
        const readmeContent = fs.readFileSync(rp, 'utf8');
        docSections = docParser.extractRelevantSections(readmeContent);
        break;
      }
    }

    // Check language manifests
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      primaryRuntime = 'node';
    } else if (
      fs.existsSync(path.join(dir, 'requirements.txt')) ||
      fs.existsSync(path.join(dir, 'pyproject.toml'))
    ) {
      primaryRuntime = 'python';
    } else if (fs.existsSync(path.join(dir, 'go.mod'))) {
      primaryRuntime = 'go';
    } else if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
      primaryRuntime = 'rust';
    }

    // Parse variables from .env.example
    const detectedVariables: Array<{ key: string; rawValue?: string; comment?: string }> = [];
    if (envExampleContent) {
      const lines = envExampleContent.split('\n');
      let lastComment = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) {
          lastComment = trimmed.replace(/^#\s*/, '');
        } else if (trimmed.includes('=')) {
          const [key, ...rest] = trimmed.split('=');
          const cleanKey = key.trim();
          if (cleanKey && /^[A-Z0-9_]+$/i.test(cleanKey)) {
            detectedVariables.push({
              key: cleanKey,
              rawValue: rest.join('=').trim(),
              comment: lastComment || undefined,
            });
            lastComment = '';
          }
        }
      }
    }

    return {
      repoUrl,
      commitHash,
      hasDockerfile,
      dockerfileContent: dockerfileContent?.slice(0, 5000),
      hasCompose,
      composeContent: composeContent?.slice(0, 5000),
      hasEnvExample,
      envExampleContent: envExampleContent?.slice(0, 5000),
      docSections,
      primaryRuntime,
      detectedPorts: detectedPorts.length > 0 ? detectedPorts : [3000],
      detectedVariables,
    };
  }
}

export const repoAnalyzer = new RepoAnalyzer();
