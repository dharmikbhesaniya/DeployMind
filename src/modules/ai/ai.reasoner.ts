import { config } from '../../config/index.js';
import type { RepoManifestSnapshot } from '../analyzer/repo.analyzer.js';
import { vaultService } from '../vault/vault.service.js';
import type { DeploymentPlan, DetectedVariable } from '../../core/types.js';

export class AIReasoner {
  // Synthesizes a full DeploymentPlan from a RepoManifestSnapshot
  async synthesizeDeploymentPlan(
    manifest: RepoManifestSnapshot,
    projectName: string
  ): Promise<DeploymentPlan> {
    // 1. Process environment variables and cross-reference with Vault
    const variables: DetectedVariable[] = [];

    // Helper to categorize variable based on key name, comment, and values
    for (const v of manifest.detectedVariables) {
      const key = v.key;
      const upper = key.toUpperCase();
      let type: DetectedVariable['type'] = 'OPTIONAL_DEFAULT';
      let recommendedGenerator: DetectedVariable['recommendedGenerator'] = 'none';

      if (
        upper.includes('SECRET') ||
        upper.includes('KEY') ||
        upper.includes('PASSWORD') ||
        upper.includes('TOKEN') ||
        upper.includes('SALT')
      ) {
        if (
          upper.includes('OPENAI') ||
          upper.includes('STRIPE') ||
          upper.includes('AWS') ||
          upper.includes('GITHUB') ||
          upper.includes('RESEND') ||
          upper.includes('SMTP') ||
          upper.includes('MAIL')
        ) {
          type = 'EXTERNAL_REQUIRED';
        } else if (
          upper.includes('DATABASE') ||
          upper.includes('POSTGRES') ||
          upper.includes('REDIS') ||
          upper.includes('MONGO')
        ) {
          type = 'INTERNAL_INFRASTRUCTURE';
        } else {
          type = 'AUTO_GENERATED_SECRET';
          recommendedGenerator = 'hex32';
        }
      } else if (upper.includes('URL') || upper.includes('URI') || upper.includes('HOST')) {
        if (upper.includes('DB') || upper.includes('DATABASE') || upper.includes('REDIS')) {
          type = 'INTERNAL_INFRASTRUCTURE';
        } else {
          type = 'EXTERNAL_REQUIRED';
        }
      }

      // Check Vault for existing credentials with identical key name
      const existingInVault = await vaultService.findCredentialsByKey(key);
      let matchingVaultCredentialId: string | undefined;
      let reusePrompt: string | undefined;

      if (existingInVault.length > 0) {
        const firstMatch = existingInVault[0];
        matchingVaultCredentialId = firstMatch.id;
        reusePrompt = `Found existing credential "${firstMatch.description}" (${firstMatch.maskedPreview}). Use existing or provide new?`;
      }

      variables.push({
        key,
        type,
        description: v.comment || `Environment variable for ${key}`,
        defaultValue: v.rawValue,
        recommendedGenerator,
        matchingVaultCredentialId,
        reusePrompt,
      });
    }

    // 2. Detect required backing services
    const requiredBackingServices: DeploymentPlan['requiredBackingServices'] = [];
    const fullText = (
      (manifest.composeContent || '') +
      ' ' +
      (manifest.envExampleContent || '') +
      ' ' +
      manifest.docSections.map((s) => s.content).join(' ')
    ).toLowerCase();

    if (fullText.includes('postgres') || fullText.includes('psql') || fullText.includes('pg_')) {
      requiredBackingServices.push({
        serviceType: 'postgres',
        strategy: 'reuse_shared',
        reason: 'PostgreSQL database dependency detected in configuration/documentation.',
      });
    }

    if (fullText.includes('redis') || fullText.includes('ioredis') || fullText.includes('bullmq')) {
      requiredBackingServices.push({
        serviceType: 'redis',
        strategy: 'reuse_shared',
        reason: 'Redis cache or queue dependency detected in configuration/documentation.',
      });
    }

    // 3. Fallback / AI Enhancements
    // If an external LLM key is configured, query the model with structured output
    if (config.ai.apiKey && manifest.docSections.length > 0) {
      try {
        const enriched = await this.queryLLMForPlan(manifest, projectName, variables, requiredBackingServices);
        return enriched;
      } catch (err) {
        console.warn('[AIReasoner] LLM query failed, falling back to deterministic plan:', err);
      }
    }

    // Deterministic Rule-Engine Plan
    const port = manifest.readmeAnalysis?.detectedPort || manifest.detectedPorts[0] || 3000;
    const slug = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-');

    return {
      projectName,
      framework: manifest.primaryRuntime || 'generic',
      runtime: manifest.primaryRuntime || 'docker',
      buildType: manifest.hasCompose
        ? 'compose'
        : manifest.hasDockerfile
        ? 'dockerfile'
        : 'nixpacks',
      exposedPort: port,
      healthCheckPath: '/',
      entrypointCommand: manifest.readmeAnalysis?.detectedStartCommand || undefined,
      migrationCommand: manifest.readmeAnalysis?.detectedMigrationCommand || (fullText.includes('prisma')
        ? 'npx prisma migrate deploy'
        : fullText.includes('drizzle')
        ? 'npm run db:push'
        : undefined),
      environmentVariables: variables,
      requiredBackingServices,
      runtimeStrategy: 'docker_priority',
      readmeSummary: {
        projectOverview: manifest.readmeAnalysis?.projectOverview || 'Application service discovered from repository.',
        howItWorks: manifest.readmeAnalysis?.howItWorks || 'Autonomous lifecycle management with reverse proxy routing.',
        setupWorkflow: manifest.readmeAnalysis?.setupWorkflow || ['Clone repository', 'Configure environment variables', 'Build production assets', 'Launch service'],
        detectedBuildCommand: manifest.readmeAnalysis?.detectedBuildCommand,
        detectedStartCommand: manifest.readmeAnalysis?.detectedStartCommand,
        detectedPort: port,
        detectedMigrationCommand: manifest.readmeAnalysis?.detectedMigrationCommand,
      },
      suggestedSubdomain: `${slug}.${config.proxy.baseDomain}`,
      volumes: [],
      securityRisks: [],
    };
  }

  // LLM Structured Output Query
  private async queryLLMForPlan(
    manifest: RepoManifestSnapshot,
    projectName: string,
    fallbackVars: DetectedVariable[],
    fallbackServices: DeploymentPlan['requiredBackingServices']
  ): Promise<DeploymentPlan> {
    const prompt = `You are an expert autonomous DevOps engineer. Analyze this repository metadata and README documentation to output a production deployment plan.

Repository: ${manifest.repoUrl}
Runtime: ${manifest.primaryRuntime || 'unknown'}
Has Dockerfile: ${manifest.hasDockerfile}
Has Compose: ${manifest.hasCompose}
Detected Ports: ${manifest.detectedPorts.join(', ')}

README Sections:
${manifest.docSections.map((s) => `### ${s.title}\n${s.content}`).join('\n\n')}

Variables from .env:
${fallbackVars.map((v) => `- ${v.key}: ${v.description}`).join('\n')}

Synthesize the final deployment plan. Return ONLY JSON conforming to:
{
  "framework": string,
  "exposedPort": number,
  "healthCheckPath": string,
  "migrationCommand": string or null,
  "summary": string
}`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
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

    if (!res.ok) throw new Error(`OpenAI API error: ${res.statusText}`);
    const data = await res.json() as any;
    const parsed = JSON.parse(data.choices[0].message.content);

    const slug = projectName.toLowerCase().replace(/[^a-z0-9]/g, '-');

    return {
      projectName,
      framework: parsed.framework || manifest.primaryRuntime || 'generic',
      runtime: manifest.primaryRuntime || 'docker',
      buildType: manifest.hasCompose
        ? 'compose'
        : manifest.hasDockerfile
        ? 'dockerfile'
        : 'nixpacks',
      exposedPort: parsed.exposedPort || manifest.detectedPorts[0] || 3000,
      healthCheckPath: parsed.healthCheckPath || '/',
      entrypointCommand: undefined,
      migrationCommand: parsed.migrationCommand || undefined,
      environmentVariables: fallbackVars,
      requiredBackingServices: fallbackServices,
      runtimeStrategy: 'docker_priority',
      readmeSummary: {
        projectOverview: manifest.readmeAnalysis?.projectOverview || 'Application service discovered from repository.',
        howItWorks: manifest.readmeAnalysis?.howItWorks || 'Autonomous lifecycle management with reverse proxy routing.',
        setupWorkflow: manifest.readmeAnalysis?.setupWorkflow || ['Clone repository', 'Configure environment variables', 'Build production assets', 'Launch service'],
        detectedBuildCommand: manifest.readmeAnalysis?.detectedBuildCommand,
        detectedStartCommand: manifest.readmeAnalysis?.detectedStartCommand,
        detectedPort: parsed.exposedPort || manifest.detectedPorts[0] || 3000,
        detectedMigrationCommand: parsed.migrationCommand,
      },
      suggestedSubdomain: `${slug}.${config.proxy.baseDomain}`,
      volumes: [],
      securityRisks: [],
    };
  }
}

export const aiReasoner = new AIReasoner();
