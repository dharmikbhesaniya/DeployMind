import { EventEmitter } from 'node:events';

export interface DeploymentLogEvent {
  deploymentId: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'success';
  stage: 'analyze' | 'plan' | 'build' | 'deploy' | 'health_check' | 'route' | 'auto_heal';
  message: string;
  details?: unknown;
}

class DeployMindEventBus extends EventEmitter {
  emitLog(log: DeploymentLogEvent): void {
    this.emit('deployment:log', log);
  }

  onLog(listener: (log: DeploymentLogEvent) => void): this {
    return this.on('deployment:log', listener);
  }
}

export const eventBus = new DeployMindEventBus();
