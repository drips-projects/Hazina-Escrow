import fs from 'fs';
import path from 'path';
import { readStore } from './storage';

export interface BackupConfig {
  enabled: boolean;
  backupDir: string;
  maxBackups: number;
  cronSchedule: string;
}

export interface BackupMetadata {
  timestamp: string;
  filename: string;
  size: number;
  datasetsCount: number;
  transactionsCount: number;
}

/**
 * Service for managing automated database backups
 */
export class BackupService {
  private config: BackupConfig;

  constructor(config: BackupConfig) {
    this.config = config;
    this.ensureBackupDirectory();
  }

  /**
   * Ensure backup directory exists
   */
  private ensureBackupDirectory(): void {
    if (!fs.existsSync(this.config.backupDir)) {
      fs.mkdirSync(this.config.backupDir, { recursive: true });
      console.log(`[Backup] Created backup directory: ${this.config.backupDir}`);
    }
  }

  /**
   * Create a backup of the current database state
   */
  async createBackup(): Promise<BackupMetadata> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `backup-${timestamp}.json`;
      const backupPath = path.join(this.config.backupDir, filename);

      // Read current store
      const store = await readStore();

      // Write backup
      const backupData = {
        metadata: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          datasetsCount: store.datasets.length,
          transactionsCount: store.transactions.length,
        },
        data: store,
      };

      fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');

      const stats = fs.statSync(backupPath);
      const metadata: BackupMetadata = {
        timestamp: new Date().toISOString(),
        filename,
        size: stats.size,
        datasetsCount: store.datasets.length,
        transactionsCount: store.transactions.length,
      };

      console.log(
        `[Backup] Created backup: ${filename} (${this.formatBytes(stats.size)}, ` +
        `${metadata.datasetsCount} datasets, ${metadata.transactionsCount} transactions)`
      );

      // Rotate old backups
      await this.rotateBackups();

      return metadata;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Backup] Failed to create backup: ${message}`);
      throw error;
    }
  }

  /**
   * Rotate backups - keep only the most recent N backups
   */
  private async rotateBackups(): Promise<void> {
    try {
      const files = fs.readdirSync(this.config.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(this.config.backupDir, f),
          mtime: fs.statSync(path.join(this.config.backupDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Delete old backups beyond maxBackups
      if (files.length > this.config.maxBackups) {
        const toDelete = files.slice(this.config.maxBackups);
        for (const file of toDelete) {
          fs.unlinkSync(file.path);
          console.log(`[Backup] Rotated old backup: ${file.name}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Backup] Failed to rotate backups: ${message}`);
    }
  }

  /**
   * List all available backups
   */
  listBackups(): BackupMetadata[] {
    try {
      const files = fs.readdirSync(this.config.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
        .map(f => {
          const filePath = path.join(this.config.backupDir, f);
          const stats = fs.statSync(filePath);
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          
          return {
            timestamp: content.metadata?.timestamp || stats.mtime.toISOString(),
            filename: f,
            size: stats.size,
            datasetsCount: content.metadata?.datasetsCount || 0,
            transactionsCount: content.metadata?.transactionsCount || 0,
          };
        })
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return files;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Backup] Failed to list backups: ${message}`);
      return [];
    }
  }

  /**
   * Restore from a specific backup
   */
  async restoreBackup(filename: string): Promise<void> {
    try {
      const backupPath = path.join(this.config.backupDir, filename);
      
      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${filename}`);
      }

      const backupContent = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
      const dataPath = path.join(__dirname, '../../../data/datasets.json');

      // Create a safety backup before restoring
      const safetyBackup = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const safetyPath = path.join(this.config.backupDir, safetyBackup);
      
      // Read current data and save as safety backup
      if (fs.existsSync(dataPath)) {
        const currentData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
        const safetyData = {
          metadata: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
            datasetsCount: currentData.datasets?.length || 0,
            transactionsCount: currentData.transactions?.length || 0,
          },
          data: currentData,
        };
        fs.writeFileSync(safetyPath, JSON.stringify(safetyData, null, 2), 'utf-8');
      }

      // Restore the backup
      fs.writeFileSync(dataPath, JSON.stringify(backupContent.data, null, 2), 'utf-8');

      console.log(`[Backup] Restored from backup: ${filename}`);
      console.log(`[Backup] Safety backup created: ${safetyBackup}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Backup] Failed to restore backup: ${message}`);
      throw error;
    }
  }

  /**
   * Get backup statistics
   */
  getBackupStats(): {
    totalBackups: number;
    totalSize: number;
    oldestBackup: string | null;
    newestBackup: string | null;
  } {
    const backups = this.listBackups();
    
    return {
      totalBackups: backups.length,
      totalSize: backups.reduce((sum, b) => sum + b.size, 0),
      oldestBackup: backups.length > 0 ? backups[backups.length - 1].timestamp : null,
      newestBackup: backups.length > 0 ? backups[0].timestamp : null,
    };
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
}
