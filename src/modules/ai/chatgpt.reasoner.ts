/**
 * ChatGPT (OpenAI GPT-4o) - System Two Reasoning & Conversational Engine
 * Formulates enterprise-grade natural conversational responses, explains service telemetry,
 * and orchestrates interactive permission/variable prompts like Claude Code.
 */

import { config } from '../../config/index.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatContext {
  activeProjects: Array<{ id: string; name: string; slug: string; repoUrl: string; status: string }>;
  activeServices: Array<{ id: string; name: string; containerId?: string; status?: string }>;
  activeRoutes: Array<{ hostname: string; targetUpstream: string }>;
  recentLogs?: string;
}

export class ChatGPTReasoner {
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = config.ai.apiKey;
    this.model = config.ai.model || 'gpt-4o';
  }

  async generateResponse(
    userMessage: string,
    history: ChatMessage[],
    systemContext: ChatContext,
    actionExecutionResult?: {
      action: string;
      success: boolean;
      output?: any;
      error?: string;
    }
  ): Promise<string> {
    if (this.apiKey) {
      try {
        return await this.queryChatGPT(userMessage, history, systemContext, actionExecutionResult);
      } catch (err) {
        console.warn('[ChatGPTReasoner] OpenAI API error, utilizing DeployMind local conversational engine:', err);
      }
    }

    // High-quality local conversational response generator
    return this.generateLocalResponse(userMessage, systemContext, actionExecutionResult);
  }

  private async queryChatGPT(
    userMessage: string,
    history: ChatMessage[],
    systemContext: ChatContext,
    actionResult?: any
  ): Promise<string> {
    const systemPrompt = `You are DeployMind AI, an autonomous enterprise self-hosting DevOps engineer and conversational platform agent (inspired by Claude Code).
You run locally, manage Docker containers, inspect logs, configure reverse proxies (Caddy/Traefik), and guide the user with calm, precise, factual answers.

CURRENT SYSTEM CONTEXT:
- Active Projects: ${JSON.stringify(systemContext.activeProjects.map((p) => ({ name: p.name, slug: p.slug, status: p.status })))}
- Running Services: ${JSON.stringify(systemContext.activeServices.map((s) => ({ name: s.name, container: s.containerId })))}
- Ingress Routes: ${JSON.stringify(systemContext.activeRoutes.map((r) => r.hostname))}
${actionResult ? `- Action Executed: ${JSON.stringify(actionResult)}` : ''}

GUIDELINES:
- Deliver clear, confident, helpful responses.
- If showing logs or commands, format them inside clean code blocks.
- If an action was performed, clearly summarize what changed and provide direct links (e.g. http://<subdomain>.localhost).
- Be concise: avoid fluff or repetitive introductions.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-8),
      { role: 'user', content: userMessage },
    ];

    const res = await fetch(config.ai.openaiApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: config.ai.openaiTemperature,
        max_tokens: config.ai.openaiMaxTokens,
      }),
      signal: AbortSignal.timeout(config.ai.openaiTimeoutMs),
    });

    if (!res.ok) throw new Error(`OpenAI request failed: ${res.statusText}`);
    const data = await res.json() as any;
    return data.choices[0].message.content.trim();
  }

  private generateLocalResponse(
    userMessage: string,
    ctx: ChatContext,
    actionResult?: any
  ): string {
    if (actionResult) {
      if (!actionResult.success) {
        return `⚠️ **Operation Failed**: ${actionResult.error || 'An error occurred while executing the action.'}`;
      }

      if (actionResult.action === 'GET_LOGS') {
        const logs = actionResult.output || 'No logs recorded yet.';
        return `### 📋 Container Logs\n\`\`\`bash\n${logs.slice(-2000)}\n\`\`\``;
      }

      if (actionResult.action === 'START_SERVICE') {
        return `✅ **Service Started**: Service container is now active and routing traffic.`;
      }

      if (actionResult.action === 'STOP_SERVICE') {
        return `⏸️ **Service Stopped**: Service container suspended safely.`;
      }

      if (actionResult.action === 'DELETE_PROJECT') {
        return `🗑️ **Project Deleted**: Project and its containers, volumes, and SQLite records have been purged.`;
      }

      if (actionResult.action === 'DEPLOY') {
        const repo = actionResult.output?.repoUrl || 'repository';
        const sub = actionResult.output?.subdomain;
        const targetUrl = sub ? (sub.startsWith('http') ? sub : `http://${sub}`) : '';
        return `🚀 **Deployment Initiated for \`${repo}\`**\n\n- **Application URL**: [${targetUrl}](${targetUrl})\n- **Pipeline**: TypeSafe Jev Calibrated Orchestration\n\nStreaming live deployment telemetry below. You can access the application at **[${targetUrl}](${targetUrl})** as soon as the ingress route is healthy:`;
      }

      if (actionResult.action === 'SYSTEM_STATUS') {
        const projCount = ctx.activeProjects.length;
        const servCount = ctx.activeServices.length;
        const routeCount = ctx.activeRoutes.length;
        return `### ⚡ System Status\n- **Active Projects**: ${projCount}\n- **Running Services**: ${servCount}\n- **Ingress Routes**: ${routeCount}\n- **Reverse Proxy**: Caddy (Ports 80 & 443)\n- **Docker Engine**: Connected`;
      }
    }

    return `Hello! I am **DeployMind AI**, powered by **TypeSafe Jev** (fast decision engine) and **ChatGPT** (conversational reasoning).

Here is what you can ask me to do in real-time:
- 🚀 **Deploy a repo**: *"Deploy https://github.com/user/repo"*
- 📋 **Check logs**: *"Show me logs for recordly"*
- ⚡ **Control services**: *"Stop service web"* or *"Start service web"*
- 🗑️ **Delete with permission**: *"Delete project recordly"*
- 📊 **Check status**: *"What services and routes are running?"*
- 🔑 **Configure variables**: *"Set DATABASE_URL=postgres://..."*`;
  }
}

export const chatGPTReasoner = new ChatGPTReasoner();
