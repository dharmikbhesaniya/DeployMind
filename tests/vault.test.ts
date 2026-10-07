import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase, db, schema } from '../src/db/index.js';
import { vaultService } from '../src/modules/vault/vault.service.js';

describe('VaultService - Reusable Credential Vault with Duplicate Key Support', () => {
  beforeAll(async () => {
    initDatabase();
    await db.insert(schema.projects).values({
      id: 'proj_test_123',
      name: 'Test Project',
      slug: 'test-project',
      repoUrl: 'https://github.com/test/repo',
      branch: 'main',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).onConflictDoNothing();

    await db.insert(schema.projects).values({
      id: 'proj_alpha',
      name: 'Alpha Project',
      slug: 'alpha-project',
      repoUrl: 'https://github.com/test/alpha',
      branch: 'main',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).onConflictDoNothing();
  });

  it('should encrypt and store a credential and generate masked preview', async () => {
    const cred = await vaultService.createCredential({
      keyName: 'OPENAI_API_KEY',
      plaintextValue: 'sk-proj-1234567890abcdef1234567890abcdef',
      description: 'Production Organization Key',
      scope: 'GLOBAL',
    });

    expect(cred.id).toBeDefined();
    expect(cred.keyName).toBe('OPENAI_API_KEY');
    expect(cred.description).toBe('Production Organization Key');
    expect(cred.maskedPreview).toContain('sk-p...cdef');
    expect(cred.scope).toBe('GLOBAL');
  });

  it('should cleanly support duplicate key names with distinct descriptions and scopes', async () => {
    // Create second credential with the identical key name but different purpose
    const cred2 = await vaultService.createCredential({
      keyName: 'OPENAI_API_KEY',
      plaintextValue: 'sk-test-sandbox-key-998877665544',
      description: 'Staging Sandbox Testing Key',
      scope: 'PROJECT_SCOPED',
      owningProjectId: 'proj_test_123',
    });

    expect(cred2.id).toBeDefined();
    expect(cred2.keyName).toBe('OPENAI_API_KEY');
    expect(cred2.description).toBe('Staging Sandbox Testing Key');
    expect(cred2.scope).toBe('PROJECT_SCOPED');

    // Query all credentials matching 'OPENAI_API_KEY'
    const matches = await vaultService.findCredentialsByKey('OPENAI_API_KEY');
    expect(matches.length).toBeGreaterThanOrEqual(2);

    const descriptions = matches.map((m) => m.description);
    expect(descriptions).toContain('Production Organization Key');
    expect(descriptions).toContain('Staging Sandbox Testing Key');
  });

  it('should bind project environment variables to specific vault credentials and decrypt them correctly', async () => {
    const cred = await vaultService.createCredential({
      keyName: 'DATABASE_URL',
      plaintextValue: 'postgresql://usr:pass@localhost:5432/mydb',
      description: 'Main Database URI',
    });

    await vaultService.bindCredentialToProject({
      projectId: 'proj_alpha',
      targetEnvVar: 'DATABASE_URL',
      vaultCredentialId: cred.id,
    });

    const resolved = await vaultService.resolveProjectVariables('proj_alpha');
    expect(resolved['DATABASE_URL']).toBe('postgresql://usr:pass@localhost:5432/mydb');
  });
});
