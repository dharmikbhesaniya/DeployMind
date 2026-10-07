import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';
import { dockerService } from '../docker/docker.service.js';
import { sqlite } from '../../db/index.js';

export interface BackupItem {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
  type: 'sqlite' | 'postgres';
}

export class BackupManager {
  private backupDir: string;

  constructor() {
    this.backupDir = path.join(config.dataDir, 'backups');
    this.ensureDir();
  }

  private ensureDir() {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  // Autonomously runs backup of SQLite database and shared databases
  async runAutomatedBackup(): Promise<BackupItem[]> {
    this.ensureDir();
    const createdBackups: BackupItem[] = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // 1. Backup internal SQLite database
    const sqliteTarget = path.join(this.backupDir, `sqlite-deployagent-${timestamp}.db`);
    try {
      await sqlite.backup(sqliteTarget);
      const stat = fs.statSync(sqliteTarget);
      createdBackups.push({
        id: `backup_sqlite_${Date.now()}`,
        name: path.basename(sqliteTarget),
        sizeBytes: stat.size,
        createdAt: Date.now(),
        type: 'sqlite',
      });
    } catch (err) {
      console.warn('[BackupManager] SQLite backup warning:', err);
    }

    // 2. Backup shared PostgreSQL database if running
    const isDocker = await dockerService.isAvailable();
    if (isDocker) {
      const pgTarget = path.join(this.backupDir, `postgres-shared-${timestamp}.sql`);
      try {
        const { exitCode, output } = await dockerService.execCommand(
          'deployagent-shared-postgres',
          ['pg_dumpall', '-U', 'deployagent_admin']
        );
        if (exitCode === 0 && output.length > 0) {
          fs.writeFileSync(pgTarget, output, 'utf8');
          const stat = fs.statSync(pgTarget);
          createdBackups.push({
            id: `backup_pg_${Date.now()}`,
            name: path.basename(pgTarget),
            sizeBytes: stat.size,
            createdAt: Date.now(),
            type: 'postgres',
          });
        }
      } catch {
        // Shared Postgres container might not be active yet
      }
    }

    // 3. Clean up backups older than 7 days
    this.cleanupOldBackups(7);

    return createdBackups;
  }

  // Lists all available backups
  listBackups(): BackupItem[] {
    this.ensureDir();
    const files = fs.readdirSync(this.backupDir);
    return files
      .map((f) => {
        const full = path.join(this.backupDir, f);
        const stat = fs.statSync(full);
        return {
          id: f,
          name: f,
          sizeBytes: stat.size,
          createdAt: stat.mtimeMs,
          type: f.endsWith('.sql') ? ('postgres' as const) : ('sqlite' as const),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private cleanupOldBackups(daysToKeep: number) {
    const maxAgeMs = daysToKeep * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const files = fs.readdirSync(this.backupDir);

    for (const file of files) {
      const full = path.join(this.backupDir, file);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(full);
      }
    }
  }
}

export const backupManager = new BackupManager();
