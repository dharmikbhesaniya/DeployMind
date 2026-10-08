import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { registerRoutes } from '../src/server/routes.js';
import { settingsService } from '../src/modules/settings/settings.service.js';
import { jevEvaluator } from '../src/modules/ai/jev.evaluator.js';
import { aiChatService } from '../src/modules/ai/chat.service.js';
import { vaultService } from '../src/modules/vault/vault.service.js';

describe('Pre-Deployment Verification & ASK/AUTO Mode Guardrails', () => {
  const app = Fastify();

  beforeAll(async () => {
    await registerRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should switch mode between ASK and AUTO via SettingsService and API', async () => {
    // 1. Initial should be ASK or set to ASK
    await settingsService.setAccessMode('ASK');
    let current = await settingsService.getAccessMode();
    expect(current).toBe('ASK');

    // 2. Set to AUTO via API
    const postRes = await app.inject({
      method: 'POST',
      url: '/api/system/settings',
      payload: { accessMode: 'AUTO' },
    });
    expect(postRes.statusCode).toBe(200);
    const body = JSON.parse(postRes.payload);
    expect(body.accessMode).toBe('AUTO');

    current = await settingsService.getAccessMode();
    expect(current).toBe('AUTO');

    // 3. Reset back to ASK
    await settingsService.setAccessMode('ASK');
    expect(await settingsService.getAccessMode()).toBe('ASK');
  });

  it('should classify natural language commands to switch access mode using TypeSafe Jev', async () => {
    const decisionAuto = await jevEvaluator.evaluateIntent('set mode to auto');
    expect(decisionAuto.choice).toBe('SET_MODE');
    expect(decisionAuto.entities.mode).toBe('AUTO');

    const decisionAsk = await jevEvaluator.evaluateIntent('switch to ask mode');
    expect(decisionAsk.choice).toBe('SET_MODE');
    expect(decisionAsk.entities.mode).toBe('ASK');
  });

  it('should execute SET_MODE in ChatService and update system state', async () => {
    const response = await aiChatService.processUserMessage('set mode to auto');
    expect(response.intent.choice).toBe('SET_MODE');
    expect(response.actionResult?.success).toBe(true);

    const mode = await settingsService.getAccessMode();
    expect(mode).toBe('AUTO');

    // Switch back to ASK mode
    const resAsk = await aiChatService.processUserMessage('set mode to ask');
    expect(resAsk.intent.choice).toBe('SET_MODE');
    expect(await settingsService.getAccessMode()).toBe('ASK');
  });

  it('should pause deployment and request missing variables/tools in chat instead of deploying directly', async () => {
    await settingsService.setAccessMode('ASK');

    // Deploy mock repository that requires variables
    const chatRes = await aiChatService.processUserMessage('Deploy https://github.com/example/sample-app');
    expect(chatRes.intent.choice).toBe('DEPLOY');

    // Should return interactive prompt because it is in ASK mode or has missing keys
    expect(chatRes.interactivePrompt).toBeDefined();
    expect(chatRes.interactivePrompt?.action).toBe('DEPLOY_CONFIRM');
    expect(chatRes.interactivePrompt?.requiredTools?.length).toBeGreaterThan(0);

    // Each required tool must have an explanation of its purpose
    for (const tool of chatRes.interactivePrompt!.requiredTools!) {
      expect(tool.name).toBeDefined();
      expect(tool.purpose).toBeDefined();
      expect(tool.commandOrPackage).toBeDefined();
    }
  });

  it('should handle confirmation, save provided variables to Vault, and trigger deployment', async () => {
    await settingsService.setAccessMode('ASK');

    const chatRes = await aiChatService.processUserMessage('Deploy https://github.com/example/sample-app');
    const promptId = chatRes.interactivePrompt?.id;
    expect(promptId).toBeDefined();

    // Confirm with custom variables and enable auto mode
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/ai/chat/confirm',
      payload: {
        promptId,
        approved: true,
        variables: {
          DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
        },
        enableAutoMode: true,
      },
    });

    expect(confirmRes.statusCode).toBe(200);
    const body = JSON.parse(confirmRes.payload);
    expect(body.success).toBe(true);
    expect(body.deploymentStream).toBeDefined();

    // Verify AUTO mode was enabled
    expect(await settingsService.getAccessMode()).toBe('AUTO');

    // Verify variable was securely saved to Vault
    const vaultCreds = await vaultService.findCredentialsByKey('DATABASE_URL');
    expect(vaultCreds.length).toBeGreaterThan(0);
  });
});
