import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { config } from '../../config/index.js';
import type { VaultCredentialItem } from '../../core/types.js';

export class VaultService {
  private masterKey: Buffer;

  constructor() {
    this.masterKey = config.masterKey;
  }

  // Encrypt plaintext secret using AES-256-GCM
  private encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');

    return {
      ciphertext,
      iv: iv.toString('hex'),
      tag,
    };
  }

  // Decrypt secret using AES-256-GCM
  private decrypt(ciphertext: string, ivHex: string, tagHex: string): string {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');
    return plaintext;
  }

  // Compute safe masked preview for display in UI
  private generateMaskedPreview(value: string): string {
    if (value.length <= 8) {
      return '••••••••';
    }
    const prefix = value.slice(0, 4);
    const suffix = value.slice(-4);
    return `${prefix}...${suffix}`;
  }

  // Find all existing credentials matching a variable key name
  async findCredentialsByKey(keyName: string): Promise<VaultCredentialItem[]> {
    const rows = await db
      .select()
      .from(schema.vaultCredentials)
      .where(eq(schema.vaultCredentials.keyName, keyName));

    const results: VaultCredentialItem[] = [];

    for (const row of rows) {
      const bindings = await db
        .select()
        .from(schema.projectCredentialBindings)
        .where(eq(schema.projectCredentialBindings.vaultCredentialId, row.id));

      results.push({
        id: row.id,
        keyName: row.keyName,
        description: row.description,
        maskedPreview: row.maskedPreview,
        scope: row.scope as 'GLOBAL' | 'PROJECT_SCOPED',
        owningProjectId: row.owningProjectId,
        isSystemGenerated: Boolean(row.isSystemGenerated),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        boundProjectsCount: bindings.length,
      });
    }

    return results;
  }

  // Create a new vault credential (supports duplicate key names cleanly)
  async createCredential(params: {
    keyName: string;
    plaintextValue: string;
    description: string;
    scope?: 'GLOBAL' | 'PROJECT_SCOPED';
    owningProjectId?: string | null;
    isSystemGenerated?: boolean;
  }): Promise<VaultCredentialItem> {
    const id = `cred_${crypto.randomUUID()}`;
    const { ciphertext, iv, tag } = this.encrypt(params.plaintextValue);
    const maskedPreview = this.generateMaskedPreview(params.plaintextValue);
    const now = Date.now();

    const newCred = {
      id,
      keyName: params.keyName,
      description: params.description,
      maskedPreview,
      encryptedValue: ciphertext,
      iv,
      tag,
      scope: params.scope || 'GLOBAL',
      owningProjectId: params.owningProjectId || null,
      isSystemGenerated: params.isSystemGenerated ?? false,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(schema.vaultCredentials).values(newCred);

    return {
      id,
      keyName: params.keyName,
      description: params.description,
      maskedPreview,
      scope: newCred.scope,
      owningProjectId: newCred.owningProjectId,
      isSystemGenerated: newCred.isSystemGenerated,
      createdAt: now,
      updatedAt: now,
      boundProjectsCount: 0,
    };
  }

  // Bind a project's target environment variable to a vault credential
  async bindCredentialToProject(params: {
    projectId: string;
    serviceId?: string | null;
    targetEnvVar: string;
    vaultCredentialId: string;
  }): Promise<void> {
    const id = `bind_${crypto.randomUUID()}`;

    // Remove any existing binding for this project + env var
    await db
      .delete(schema.projectCredentialBindings)
      .where(
        and(
          eq(schema.projectCredentialBindings.projectId, params.projectId),
          eq(schema.projectCredentialBindings.targetEnvVar, params.targetEnvVar)
        )
      );

    await db.insert(schema.projectCredentialBindings).values({
      id,
      projectId: params.projectId,
      serviceId: params.serviceId || null,
      targetEnvVar: params.targetEnvVar,
      vaultCredentialId: params.vaultCredentialId,
      createdAt: Date.now(),
    });
  }

  // Resolve all decrypted environment variables for a project
  async resolveProjectVariables(projectId: string): Promise<Record<string, string>> {
    const bindings = await db
      .select({
        targetEnvVar: schema.projectCredentialBindings.targetEnvVar,
        encryptedValue: schema.vaultCredentials.encryptedValue,
        iv: schema.vaultCredentials.iv,
        tag: schema.vaultCredentials.tag,
      })
      .from(schema.projectCredentialBindings)
      .innerJoin(
        schema.vaultCredentials,
        eq(schema.projectCredentialBindings.vaultCredentialId, schema.vaultCredentials.id)
      )
      .where(eq(schema.projectCredentialBindings.projectId, projectId));

    const resolved: Record<string, string> = {};

    for (const b of bindings) {
      resolved[b.targetEnvVar] = this.decrypt(b.encryptedValue, b.iv, b.tag);
    }

    return resolved;
  }

  // Helper to generate high-entropy random secrets
  generateRandomSecret(format: 'hex32' | 'uuid' | 'base64' = 'hex32'): string {
    switch (format) {
      case 'uuid':
        return crypto.randomUUID();
      case 'base64':
        return crypto.randomBytes(32).toString('base64');
      case 'hex32':
      default:
        return crypto.randomBytes(32).toString('hex');
    }
  }
}

export const vaultService = new VaultService();
