import Docker from 'dockerode';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
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

      const dockerBin =
        ['docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'].find(
          (p) => fs.existsSync(p) || p === 'docker'
        ) || 'docker';

      const args = ['build', '-t', params.tag];
      if (params.dockerfilePath) {
        args.push('-f', params.dockerfilePath);
      }
      args.push(params.contextDir);

      try {
        const proc = spawn(dockerBin, args, {
          cwd: params.contextDir,
          env: {
            ...process.env,
            PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
            DOCKER_HOST: `unix://${config.docker.socketPath}`,
            CI: 'true',
            CSC_IDENTITY_AUTO_DISCOVERY: 'false',
            CODE_SIGN_IDENTITY: '-',
            CODE_SIGNING_REQUIRED: 'NO',
            CODE_SIGNING_ALLOWED: 'NO',
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

  // Ensure DeployMind Caddy reverse proxy container is running on deploymind-net
  async ensureCaddyContainer(): Promise<boolean> {
    try {
      const isAvail = await this.isAvailable();
      if (!isAvail) return false;

      await this.ensureNetwork();

      const caddyDir = path.resolve('.data/caddy');
      if (!fs.existsSync(caddyDir)) {
        fs.mkdirSync(caddyDir, { recursive: true });
      }
      const caddyJsonPath = path.join(caddyDir, 'caddy.json');
      if (!fs.existsSync(caddyJsonPath)) {
        const initialConfig = {
          admin: {
            listen: '0.0.0.0:2019',
            enforce_origin: false,
          },
          apps: {
            http: {
              servers: {
                srv0: {
                  listen: [':80', ':443'],
                  routes: [],
                },
              },
            },
          },
        };
        fs.writeFileSync(caddyJsonPath, JSON.stringify(initialConfig, null, 2), 'utf8');
      }

      const containerName = 'deploymind-caddy';
      try {
        const container = this.docker.getContainer(containerName);
        const inspect = await container.inspect();
        if (inspect.State.Running) {
          return true;
        }
        await container.start();
        return true;
      } catch {
        // Container does not exist yet
      }

      // Check if image exists, pull if missing
      try {
        await this.docker.getImage('caddy:alpine').inspect();
      } catch {
        await new Promise<void>((resolve) => {
          this.docker.pull('caddy:alpine', (err: any, stream: any) => {
            if (err || !stream) return resolve();
            this.docker.modem.followProgress(stream, () => resolve());
          });
        });
      }

      const container = await this.docker.createContainer({
        name: containerName,
        Image: 'caddy:alpine',
        Cmd: ['caddy', 'run', '--config', '/etc/caddy/caddy.json'],
        ExposedPorts: {
          '80/tcp': {},
          '443/tcp': {},
          '2019/tcp': {},
        },
        HostConfig: {
          NetworkMode: this.networkName,
          PortBindings: {
            '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }],
            '443/tcp': [{ HostIp: '0.0.0.0', HostPort: '443' }],
            '2019/tcp': [{ HostIp: '0.0.0.0', HostPort: '2019' }],
          },
          Binds: [`${caddyJsonPath}:/etc/caddy/caddy.json`],
          RestartPolicy: { Name: 'unless-stopped' },
        },
      });

      await container.start();
      return true;
    } catch (err: any) {
      console.warn('[DockerService] Could not auto-start Caddy proxy container:', err?.message || err);
      return false;
    }
  }

  async findAvailablePort(startPort = 4000): Promise<number> {
    let port = startPort;
    while (port < 65535) {
      if (port === 3000 || port === 5173 || port === 2019) {
        port++;
        continue;
      }
      const isFree = await new Promise<boolean>((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => {
          s.close(() => resolve(true));
        });
        s.listen(port, '127.0.0.1');
      });
      if (isFree) return port;
      port++;
    }
    return startPort;
  }

  // Create and start application container
  async startContainer(params: {
    containerName: string;
    imageTag: string;
    env: Record<string, string>;
    exposedPort: number;
    hostPort?: number;
    memoryLimitMb?: number;
    cpuLimit?: number;
  }): Promise<{ containerId: string; hostPort: number }> {
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

    const hostPort =
      params.hostPort ||
      (await this.findAvailablePort(
        params.exposedPort === 3000 || params.exposedPort === 5173 ? 4000 : params.exposedPort
      ));
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
        PortBindings: {
          [`${params.exposedPort}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: hostPort.toString() }],
        },
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: memoryBytes,
        NanoCpus: nanoCpus,
      },
    });

    await container.start();
    return { containerId: container.id, hostPort };
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
