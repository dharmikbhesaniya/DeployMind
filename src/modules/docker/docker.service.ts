import Docker from 'dockerode';
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
