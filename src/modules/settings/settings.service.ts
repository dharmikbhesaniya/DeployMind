import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

import { config } from '../../config/index.js';

export type AccessMode = 'ASK' | 'AUTO';

export interface SystemSettingsPayload {
  accessMode: AccessMode;
  autoHealEnabled: boolean;
  baseDomain: string;
}

export class SettingsService {
  async getAccessMode(): Promise<AccessMode> {
    try {
      const [record] = await db
        .select()
        .from(schema.systemSettings)
        .where(eq(schema.systemSettings.key, 'access_mode'));
      if (record?.value === 'AUTO') {
        return 'AUTO';
      }
    } catch {
      // Defaults to ASK
    }
    return 'ASK';
  }

  async setAccessMode(mode: AccessMode): Promise<AccessMode> {
    const validMode: AccessMode = mode === 'AUTO' ? 'AUTO' : 'ASK';
    await db
      .insert(schema.systemSettings)
      .values({
        key: 'access_mode',
        value: validMode,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: schema.systemSettings.key,
        set: {
          value: validMode,
          updatedAt: Date.now(),
        },
      });
    return validMode;
  }

  async getBaseDomain(): Promise<string> {
    try {
      const [record] = await db
        .select()
        .from(schema.systemSettings)
        .where(eq(schema.systemSettings.key, 'base_domain'));
      if (record?.value && record.value.trim().length > 0) {
        return record.value.trim();
      }
    } catch {
      // Defaults to config
    }
    return config.proxy.baseDomain || 'localhost';
  }

  async setBaseDomain(rawDomain: string): Promise<string> {
    let clean = (rawDomain || '').trim().toLowerCase();
    clean = clean.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!clean) {
      clean = 'localhost';
    }

    await db
      .insert(schema.systemSettings)
      .values({
        key: 'base_domain',
        value: clean,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: schema.systemSettings.key,
        set: {
          value: clean,
          updatedAt: Date.now(),
        },
      });

    // Update in-memory configuration
    config.proxy.baseDomain = clean;
    return clean;
  }

  async getAllSettings(): Promise<SystemSettingsPayload> {
    const accessMode = await this.getAccessMode();
    const baseDomain = await this.getBaseDomain();
    return {
      accessMode,
      autoHealEnabled: true,
      baseDomain,
    };
  }
}

export const settingsService = new SettingsService();
