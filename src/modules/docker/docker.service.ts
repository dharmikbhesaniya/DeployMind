import Docker from 'dockerode';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';

export class DockerService {
  private docker: Docker;
  readonly networkName = 'deploymind-net';

  constructor() {
    this.docker = new Docker({ socketPath: config.docker.socketPath });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  // Build a Docker image from context directory
  async buildImage(params: {
    contextDir: string;
    tag: string;
    dockerfilePath?: string;
    onLog?: (line: string) => void;
  }): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const dockerfile = params.dockerfilePath || path.join(params.contextDir, 'Dockerfile');
      if (!fs.existsSync(dockerfile)) {
        return resolve({ success: false, error: `Dockerfile not found at ${dockerfile}` });
      }

      const args = ['build', '-t', params.tag];
      if (params.dockerfilePath) {
        args.push('-f', params.dockerfilePath);
      }
      args.push(params.contextDir);

      try {
        const proc = spawn('docker', args, {
          cwd: params.contextDir,
          env: {
            ...process.env,
            DOCKER_HOST: `unix://${config.docker.socketPath}`,
          },
        });

        let errorOutput = '';

        proc.stdout.on('data', (data) => {
          const text = data.toString('utf8');
          if (params.onLog) {
            text.split('\n').filter(Boolean).forEach((line: string) => params.onLog!(line));
          }
        });

        proc.stderr.on('data', (data) => {
          const text = data.toString('utf8');
          errorOutput += text;
          if (params.onLog) {
            text.split('\n').filter(Boolean).forEach((line: string) => params.onLog!(line));
          }
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({
              success: false,
              error: errorOutput.trim() || `Docker build exited with code ${code}`,
            });
          }
        });

        proc.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      } catch (err: any) {
        resolve({ success: false, error: err.message });
      }
    });
  }

  // Ensure isolated bridge network exists for inter-container & proxy communication
  async ensureNetwork(): Promise<string> {
    try {
      const networks = await this.docker.listNetworks();
      const existing = networks.find((n) => n.Name === this.networkName);
      if (existing) return existing.Id;

      const created = await this.docker.createNetwork({
        Name: this.networkName,
        Driver: 'bridge',
        CheckDuplicate: true,
      });
      return created.id;
    } catch (err: any) {
      if (err.statusCode === 409) return this.networkName;
      throw err;
    }
  }

  // Create and start application container
  async startContainer(params: {
    containerName: string;
    imageTag: string;
    env: Record<string, string>;
    exposedPort: number;
    memoryLimitMb?: number;
    cpuLimit?: number;
  }): Promise<{ containerId: string }> {
    await this.ensureNetwork();

    // Check if container already exists and stop it
    try {
      const existing = this.docker.getContainer(params.containerName);
      const inspect = await existing.inspect();
      if (inspect.State.Running) {
        await existing.stop({ t: 5 });
      }
      await existing.remove({ force: true });
    } catch {
      // Container didn't exist, proceed
    }

    const envArray = Object.entries(params.env).map(([k, v]) => `${k}=${v}`);

    const memoryBytes = (params.memoryLimitMb || 1024) * 1024 * 1024;
    const nanoCpus = (params.cpuLimit || 1) * 1e9;

    const container = await this.docker.createContainer({
      name: params.containerName,
      Image: params.imageTag,
      Env: envArray,
      ExposedPorts: {
        [`${params.exposedPort}/tcp`]: {},
      },
      HostConfig: {
        NetworkMode: this.networkName,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: memoryBytes,
        NanoCpus: nanoCpus,
      },
    });

    await container.start();
    return { containerId: container.id };
  }

  // Stop and remove container
  async stopAndRemove(containerNameOrId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerNameOrId);
      await container.stop({ t: 5 });
      await container.remove({ force: true });
    } catch {
      // Ignored if already removed
    }
  }

  // Read tail of container logs (stdout + stderr)
  async getContainerLogs(containerNameOrId: string, tail = 100): Promise<string> {
    try {
      const container = this.docker.getContainer(containerNameOrId);
      const logBuffer = await container.logs({
        stdout: true,
        stderr: true,
        tail,
        timestamps: true,
      });
      return logBuffer.toString('utf8');
    } catch {
      return '';
    }
  }

  // Run a command inside container (e.g. database migrations)
  async execCommand(containerNameOrId: string, cmd: string[]): Promise<{ exitCode: number; output: string }> {
    const container = this.docker.getContainer(containerNameOrId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ Detach: false });
    let output = '';

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const inspect = await exec.inspect();
    return { exitCode: inspect.ExitCode || 0, output };
  }
}

export const dockerService = new DockerService();
