import postgresConnector from '../connectors/postgres';
import { PgTableChangeStat, ChangeDetectionResult } from '../types';
import logger from './logger';

class PgChangeDetector {
  private lastKnownStats: Map<string, PgTableChangeStat> = new Map();

  /**
   * Get current table statistics and compare with last known snapshot.
   * After comparison, immediately updates lastKnownStats with the fetched values
   * to prevent Race Condition (snapshot is atomically tied to the same query result).
   * @param tableNames Optional filter for specific table names
   */
  async checkChanges(tableNames?: string[]): Promise<ChangeDetectionResult[]> {
    const currentStats = await postgresConnector.getTableChangeStats(tableNames);
    const results: ChangeDetectionResult[] = [];

    for (const stat of currentStats) {
      const prev = this.lastKnownStats.get(stat.tableName);

      if (!prev) {
        // First observation: mark as changed so initial sync proceeds
        results.push({
          tableName: stat.tableName,
          hasChanged: true,
          insertedDiff: stat.insertedCount,
          updatedDiff: stat.updatedCount,
          deletedDiff: stat.deletedCount,
          totalChangesDiff: stat.totalChanges,
          currentStats: stat,
        });
      } else {
        const insertedDiff = Math.max(0, stat.insertedCount - prev.insertedCount);
        const updatedDiff = Math.max(0, stat.updatedCount - prev.updatedCount);
        const deletedDiff = Math.max(0, stat.deletedCount - prev.deletedCount);
        const totalChangesDiff = stat.totalChanges - prev.totalChanges;

        // If statistics were reset on DB server (current < prev), treat as changed to be safe
        // If tuple stats are all 0 (Read-Replica without PG_MASTER_HOST), treat as changed so incremental UPSERT runs reliably
        const isReadReplicaWithoutMaster = stat.insertedCount === 0 && stat.updatedCount === 0 && stat.deletedCount === 0 && !process.env.PG_MASTER_HOST;

        const hasChanged = isReadReplicaWithoutMaster || totalChangesDiff !== 0 || stat.totalChanges < prev.totalChanges;

        results.push({
          tableName: stat.tableName,
          hasChanged,
          insertedDiff,
          updatedDiff,
          deletedDiff,
          totalChangesDiff: Math.max(0, totalChangesDiff),
          currentStats: stat,
        });
      }

      // Immediately update snapshot with the same stat used for comparison
      // This prevents Race Condition: no gap between "check" and "save snapshot"
      this.lastKnownStats.set(stat.tableName, stat);
    }

    return results;
  }

  /**
   * Get list of table names that have changed since last snapshot
   * @param tableNames Array of table names to check
   */
  async getChangedTableNames(tableNames: string[]): Promise<{ changedTables: string[]; unchangedTables: string[] }> {
    if (!tableNames || tableNames.length === 0) {
      return { changedTables: [], unchangedTables: [] };
    }

    try {
      const changeResults = await this.checkChanges(tableNames);
      const changedTables = changeResults.filter(r => r.hasChanged).map(r => r.tableName);
      const unchangedTables = changeResults.filter(r => !r.hasChanged).map(r => r.tableName);

      logger.info(`----------------------------------------------------------------------`);
      logger.info(`🔍 [SMART SYNC] ผลการตรวจสอบความเปลี่ยนแปลง (pg_stat_user_tables)`);
      logger.info(`📊 สรุป: พบการเปลี่ยนแปลง ${changedTables.length} จากทั้งหมด ${tableNames.length} ตาราง`);
      if (changedTables.length > 0) {
        logger.info(`✅ ตารางที่มีข้อมูลเปลี่ยน (${changedTables.length} ตาราง): ${changedTables.join(', ')}`);
      } else {
        logger.info(`✅ ทุกตารางไม่มีข้อมูลเปลี่ยนแปลง (Skip ทั้งหมด ${unchangedTables.length} ตาราง)`);
      }
      logger.info(`----------------------------------------------------------------------`);

      return { changedTables, unchangedTables };
    } catch (error) {
      const err = error as Error;
      logger.error(`[SMART SYNC] ⚠️ เกิดข้อผิดพลาดในการเช็คความเปลี่ยนแปลง: ${err.message}. จะทำการ Sync ทุกตารางตามปกติ.`);
      // Fallback: if check fails, consider all tables as changed
      return { changedTables: tableNames, unchangedTables: [] };
    }
  }

  /**
   * Update snapshot after successful transfer/sync.
   * Fetches fresh stats from Master DB to capture any changes that occurred during transfer.
   * @param tableNames Table names to update snapshot for
   */
  async updateSnapshot(tableNames?: string[]): Promise<void> {
    try {
      const currentStats = await postgresConnector.getTableChangeStats(tableNames);
      for (const stat of currentStats) {
        this.lastKnownStats.set(stat.tableName, stat);
      }
      logger.info(`[CHANGE DETECTOR] Snapshot updated for ${currentStats.length} tables`);
    } catch (error) {
      const err = error as Error;
      logger.error(`[CHANGE DETECTOR] Failed to update snapshot: ${err.message}`);
    }
  }

  /**
   * Get all cached snapshots
   */
  getSnapshots(): Record<string, PgTableChangeStat> {
    const obj: Record<string, PgTableChangeStat> = {};
    this.lastKnownStats.forEach((val, key) => {
      obj[key] = val;
    });
    return obj;
  }

  /**
   * Clear snapshots
   */
  clearSnapshots(): void {
    this.lastKnownStats.clear();
    logger.info('[CHANGE DETECTOR] Snapshots cleared');
  }
}

export default new PgChangeDetector();
