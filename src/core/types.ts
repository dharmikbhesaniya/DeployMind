import { z } from 'zod';

export type DeploymentStatus =
  | 'analyzing'
  | 'plan_ready'
  | 'deploying'
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'rolled_back';

export type VariableType =
  | 'AUTO_GENERATED_SECRET'
  | 'INTERNAL_INFRASTRUCTURE'
  | 'EXTERNAL_REQUIRED'
  | 'OPTIONAL_DEFAULT';

export const DetectedVariableSchema = z.object({
  key: z.string(),
  type: z.enum([
    'AUTO_GENERATED_SECRET',
    'INTERNAL_INFRASTRUCTURE',
    'EXTERNAL_REQUIRED',
    'OPTIONAL_DEFAULT',
  ]),
  description: z.string(),
  defaultValue: z.string().optional(),
  recommendedGenerator: z.enum(['hex32', 'uuid', 'base64', 'none']).default('none'),
  matchingVaultCredentialId: z.string().optional(),
  reusePrompt: z.string().optional(),
});

export type DetectedVariable = z.infer<typeof DetectedVariableSchema>;

export const DeploymentPlanSchema = z.object({
  projectName: z.string(),
  framework: z.string(),
  runtime: z.string(),
  buildType: z.enum(['dockerfile', 'compose', 'nixpacks', 'static']),
  exposedPort: z.number().default(3000),
  healthCheckPath: z.string().default('/'),
  entrypointCommand: z.string().optional(),
  migrationCommand: z.string().optional(),
  environmentVariables: z.array(DetectedVariableSchema),
  requiredBackingServices: z.array(
    z.object({
      serviceType: z.enum(['postgres', 'redis', 'mysql', 'mongodb', 'minio']),
      strategy: z.enum(['reuse_shared', 'dedicated_container']),
      reason: z.string(),
    })
  ),
  runtimeStrategy: z.enum(['docker_priority', 'native_production']).default('docker_priority'),
  readmeSummary: z
    .object({
      projectOverview: z.string().default(''),
      howItWorks: z.string().default(''),
      setupWorkflow: z.array(z.string()).default([]),
      detectedBuildCommand: z.string().optional(),
      detectedStartCommand: z.string().optional(),
      detectedPort: z.number().optional(),
      detectedMigrationCommand: z.string().optional(),
    })
    .optional(),
  suggestedSubdomain: z.string(),
  volumes: z.array(
    z.object({
      containerPath: z.string(),
      hostVolumeName: z.string(),
    })
  ).default([]),
  securityRisks: z.array(z.string()).default([]),
});

export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;

export interface VaultCredentialItem {
  id: string;
  keyName: string;
  description: string;
  maskedPreview: string;
  scope: 'GLOBAL' | 'PROJECT_SCOPED';
  owningProjectId?: string | null;
  isSystemGenerated: boolean;
  createdAt: number;
  updatedAt: number;
  boundProjectsCount?: number;
}

export interface IngressRoute {
  routeId: string;
  hostname: string;
  targetUpstream: string;
  provider: 'caddy' | 'traefik';
  sslActive: boolean;
}

export interface ProxyAdapter {
  type: 'caddy' | 'traefik';
  isAvailable(): Promise<boolean>;
  registerRoute(route: IngressRoute): Promise<void>;
  removeRoute(routeId: string): Promise<void>;
  listRoutes(): Promise<IngressRoute[]>;
  checkCertificateStatus(hostname: string): Promise<{ active: boolean; details?: string }>;
}
