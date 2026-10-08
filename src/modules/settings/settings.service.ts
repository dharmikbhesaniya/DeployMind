import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

export type AccessMode = 'ASK' | 'AUTO';

export interface SystemSettingsPayload {
  accessMode: AccessMode;
  autoHealEnabled: boolean;
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

  async getAllSettings(): Promise<SystemSettingsPayload> {
    const accessMode = await this.getAccessMode();
    return {
      accessMode,
      autoHealEnabled: true,
    };
  }
}

export const settingsService = new SettingsService();
