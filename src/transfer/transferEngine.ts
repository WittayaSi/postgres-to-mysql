import pLimit from 'p-limit';
import postgres from '../connectors/postgres';
import mysqlConnector from '../connectors/mysql';
import tableClassifier from '../classifiers/tableClassifier';
import config from '../config';
import transferHistory from './transferHistory';
import logger from '../utils/logger';
import pgChangeDetector from '../utils/pgChangeDetector';
import aiDiagnoser from '../ai/aiDiagnoser';
import { sendTelegramMessage } from '../utils/telegram';
import {
  TransferType,
  TransferOptions,
  TransferResult,
  TableTransferResult,
  WorkerStatus,
  WorkerStatuses,
  ClassifiedTable,
  TableStatus,
  ValidationResult,
} from '../types';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parent FK relationships for IPD detail tables lacking direct 'an' column
export interface ParentLinkConfig {
  parentTable: string;
  fkColumn: string;
  grandparentTable?: string;
  grandparentFkColumn?: string;
}

export const IPD_PARENT_LINKS: Record<string, ParentLinkConfig> = {
  ipd_doctor_order_detail: { parentTable: 'ipd_doctor_order', fkColumn: 'ipd_doctor_order_id' },
  ipd_doctor_order_exm_detail: { parentTable: 'ipd_doctor_order_detail', fkColumn: 'ipd_doctor_order_detail_id', grandparentTable: 'ipd_doctor_order', grandparentFkColumn: 'ipd_doctor_order_id' },
  ipd_doctor_order_med_detail: { parentTable: 'ipd_doctor_order_detail', fkColumn: 'ipd_doctor_order_detail_id', grandparentTable: 'ipd_doctor_order', grandparentFkColumn: 'ipd_doctor_order_id' },
  ipd_doctor_order_opr_detail: { parentTable: 'ipd_doctor_order_detail', fkColumn: 'ipd_doctor_order_detail_id', grandparentTable: 'ipd_doctor_order', grandparentFkColumn: 'ipd_doctor_order_id' },
  ipd_do_schedule_detail: { parentTable: 'ipd_doctor_order_detail', fkColumn: 'ipd_doctor_order_detail_id', grandparentTable: 'ipd_doctor_order', grandparentFkColumn: 'ipd_doctor_order_id' },
  ipd_doctor_order_line_notify: { parentTable: 'ipd_doctor_order', fkColumn: 'ipd_doctor_order_id' },
  ipd_doctor_order_audit: { parentTable: 'ipd_doctor_order', fkColumn: 'ipd_doctor_order_id' },
  ipd_doctor_order_image: { parentTable: 'ipd_doctor_order', fkColumn: 'ipd_doctor_order_id' }
};

// Worker statuses for multi-tab support
const workerStatuses: WorkerStatuses = {};

class TransferEngine {
  private batchSize: number;
  private throttleMs: number;
  private cleanupTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  private globalTransferLimit = pLimit(1);
  public isShuttingDown: boolean = false;

  constructor() {
    this.batchSize = parseInt(process.env.BATCH_SIZE || '500');
    this.throttleMs = parseInt(process.env.TRANSFER_THROTTLE_MS || '150');
  }

  /**
   * Calculates dynamic batchSize and throttleMs based on time of day:
   * - Service Hours (08:00 - 16:30): Gentle mode (Throttle: 300ms, Batch: 300)
   * - Night Hours (22:00 - 05:00): Fast mode (Throttle: 50ms, Batch: 1000)
   * - Off-Peak Day/Evening Hours: Standard mode (Throttle: 150ms, Batch: 500)
   */
  public getDynamicTransferParams(): { batchSize: number; throttleMs: number; modeName: string } {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentMinOfDay = hours * 60 + minutes;

    // Service Hours: 08:00 (480 mins) to 16:30 (990 mins)
    const isServiceHours = currentMinOfDay >= 8 * 60 && currentMinOfDay <= (16 * 60 + 30);
    // Night Hours: 22:00 (1320 mins) to 05:00 (300 mins)
    const isNightHours = currentMinOfDay >= 22 * 60 || currentMinOfDay < 5 * 60;

    const baseBatchSize = parseInt(process.env.BATCH_SIZE || '500');
    const baseThrottleMs = parseInt(process.env.TRANSFER_THROTTLE_MS || '150');

    if (isServiceHours) {
      const serviceThrottle = parseInt(process.env.SERVICE_THROTTLE_MS || '300');
      const serviceBatch = parseInt(process.env.SERVICE_BATCH_SIZE || '300');
      return { 
        batchSize: serviceBatch, 
        throttleMs: serviceThrottle, 
        modeName: `เวลาทำการ (08:00-16:30น. - Throttle: ${serviceThrottle}ms, Batch: ${serviceBatch})` 
      };
    }

    if (isNightHours) {
      const nightThrottle = parseInt(process.env.NIGHT_THROTTLE_MS || '50');
      const nightBatch = parseInt(process.env.NIGHT_BATCH_SIZE || '1000');
      return { 
        batchSize: nightBatch, 
        throttleMs: nightThrottle, 
        modeName: `กลางคืน (22:00-05:00น. - Throttle: ${nightThrottle}ms, Batch: ${nightBatch})` 
      };
    }

    return { 
      batchSize: baseBatchSize, 
      throttleMs: baseThrottleMs, 
      modeName: `นอกเวลาทำการ (Throttle: ${baseThrottleMs}ms, Batch: ${baseBatchSize})` 
    };
  }

  getWorkerStatus(workerId: string = 'default'): WorkerStatus | null {
    return workerStatuses[workerId] || null;
  }

  getAllStatuses(): WorkerStatuses {
    return { ...workerStatuses };
  }

  /**
   * Schedule cleanup of heavy data from a worker status after transfer completes.
   * Keeps summary logs so UI status is preserved, while releasing detailed table statuses to free memory.
   */
  private scheduleWorkerCleanup(workerId: string): void {
    if (this.cleanupTimers[workerId]) {
      clearTimeout(this.cleanupTimers[workerId]);
    }
    this.cleanupTimers[workerId] = setTimeout(() => {
      if (workerStatuses[workerId] && !workerStatuses[workerId].isRunning) {
        // Keep top summary logs so UI displays completion state instead of turning blank
        if (workerStatuses[workerId].transferLogs) {
          workerStatuses[workerId].transferLogs = workerStatuses[workerId].transferLogs!.slice(0, 5);
        }
        workerStatuses[workerId].tableStatuses = {};
        logger.info(`[CLEANUP] Retained summary logs and freed detailed table statuses for worker: ${workerId}`);
      }
      delete this.cleanupTimers[workerId];
    }, 30 * 60 * 1000); // 30 minutes
  }

  /**
   * Remove entirely stale worker entries that haven't been active for 30+ minutes.
   * Called periodically from server.ts.
   */
  cleanupStaleWorkers(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [workerId, status] of Object.entries(workerStatuses)) {
      if (!status.isRunning && status.endTime) {
        const endTime = new Date(status.endTime).getTime();
        // If it ended more than 30 minutes ago, delete it completely
        if (now - endTime > 30 * 60 * 1000) {
          delete workerStatuses[workerId];
          if (this.cleanupTimers[workerId]) {
            clearTimeout(this.cleanupTimers[workerId]);
            delete this.cleanupTimers[workerId];
          }
          cleaned++;
        }
      }
    }
    if (cleaned > 0) {
      logger.info(`[CLEANUP] Removed ${cleaned} stale worker records from memory`);
    }
  }

  /**
   * Initiates a graceful shutdown of the transfer engine.
   * Stops accepting new tables and waits for currently transferring tables to finish.
   */
  async shutdown(): Promise<void> {
    logger.info('TransferEngine shutdown initiated...');
    this.isShuttingDown = true;

    // Check if any worker is currently running
    const activeWorkers = Object.values(workerStatuses).filter(w => w.isRunning);
    if (activeWorkers.length === 0) {
      logger.info('No active transfers. Safe to shutdown.');
      return;
    }

    logger.info(`Waiting for ${activeWorkers.length} active transfer(s) to finish current table...`);
    
    // Wait for all active workers to finish their current table operation (max 30 seconds)
    const timeout = 30000;
    const startWait = Date.now();
    
    while (Date.now() - startWait < timeout) {
      const stillRunning = Object.values(workerStatuses).filter(w => w.isRunning);
      if (stillRunning.length === 0) {
        logger.info('All active transfers finished current operations gracefully.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    logger.warn('TransferEngine shutdown timeout reached. Some transfers may be interrupted.');
  }

  stopWorker(workerId: string = 'default'): boolean {
    if (workerStatuses[workerId]?.isRunning) {
      workerStatuses[workerId].isAborted = true;
      logger.warn(`[STOP] Manual abort requested for worker: ${workerId}`);
      if (workerStatuses[workerId].transferLogs) {
        workerStatuses[workerId].transferLogs!.unshift({
          time: new Date().toLocaleTimeString('th-TH'),
          type: 'warning',
          message: '🛑 ยกเลิกการโอนย้ายตามคำสั่งผู้ใช้'
        });
      }
      return true;
    }
    return false;
  }

  resetWorkerStatus(workerId: string = 'default'): void {
    if (this.cleanupTimers[workerId]) {
      clearTimeout(this.cleanupTimers[workerId]);
      delete this.cleanupTimers[workerId];
    }
    workerStatuses[workerId] = {
      isRunning: false,
      isAborted: false,
      type: null,
      currentTable: '',
      progress: 0,
      totalTables: 0,
      completedTables: 0,
      currentRecords: 0,
      totalRecords: 0,
      startTime: undefined,
      endTime: undefined,
      errors: [],
      workerId,
      tableStatuses: {},
      transferLogs: [],
      validation: []
    };
  }

  async transferBasic(options: TransferOptions = {}): Promise<TransferResult> {
    return this.transfer('basic', options);
  }

  async transferOpd(options: TransferOptions = {}): Promise<TransferResult> {
    return this.transfer('opd', options);
  }

  async transferIpd(options: TransferOptions = {}): Promise<TransferResult> {
    return this.transfer('ipd', options);
  }

  async transfer(type: TransferType, options: TransferOptions = {}): Promise<TransferResult> {
    const { 
      dryRun = false, 
      tables: specificTables = null, 
      from = null, 
      to = null,
      workerId = 'default',
      ipdDaysBack = 45,
      smartSync = false,
      source = 'manual'
    } = options as TransferOptions & { source?: 'manual' | 'scheduler' };
    
    // Check if this worker is already running
    if (workerStatuses[workerId]?.isRunning) {
      throw new Error(`Worker ${workerId} is already running`);
    }

    const startTime = Date.now();
    workerStatuses[workerId] = {
      isRunning: true,
      type,
      currentTable: null,
      progress: 0,
      totalTables: 0,
      completedTables: 0,
      currentRecords: 0,
      totalRecords: 0,
      startTime: new Date().toISOString(),
      errors: [],
      workerId,
      tableStatuses: {},
      transferLogs: [],
    };

    const dynamicParams = this.getDynamicTransferParams();
    logger.info(`[${workerId}] Starting ${type} transfer using ${dynamicParams.modeName}`, { dryRun, specificTables, from, to, smartSync });
    workerStatuses[workerId].transferLogs!.unshift({
      time: new Date().toLocaleTimeString('th-TH'),
      type: 'info',
      message: `⚙️ ระบบใช้ ${dynamicParams.modeName}`
    });

    let transferResult: TransferResult;

    try {
      // Get tables to transfer
      let tablesToTransfer: ClassifiedTable[];
      if (specificTables && specificTables.length > 0) {
        const allClassified = await tableClassifier.classify();
        const allTables = [...allClassified.basic, ...allClassified.opd, ...allClassified.ipd];
        
        // Deduplicate tables by name to prevent transferring the same table twice 
        // if it belongs to multiple categories (e.g. having both vn and an)
        const uniqueTablesMap = new Map<string, ClassifiedTable>();
        allTables.forEach(t => {
          if (specificTables.includes(t.name) && !uniqueTablesMap.has(t.name)) {
            uniqueTablesMap.set(t.name, t);
          }
        });
        tablesToTransfer = Array.from(uniqueTablesMap.values());
      } else {
        switch (type) {
          case 'basic':
            tablesToTransfer = await tableClassifier.getBasicTables();
            break;
          case 'opd':
            // OPD tables now include all tables with VN column
            tablesToTransfer = await tableClassifier.getOpdTables();
            break;
          case 'ipd':
            tablesToTransfer = await tableClassifier.getIpdTables();
            break;
          default:
            throw new Error(`Unknown type: ${type}`);
        }
      }

    // Smart Sync check: filter out tables that haven't changed in Postgres
    let changedTableSet: Set<string> | null = null;
    if (smartSync && tablesToTransfer.length > 0) {
      const allTableNames = tablesToTransfer.map(t => t.name);
      const { changedTables, unchangedTables } = await pgChangeDetector.getChangedTableNames(allTableNames);
      changedTableSet = new Set(changedTables);
      logger.info(`[${workerId}] Smart Sync enabled: ${changedTables.length}/${allTableNames.length} tables changed.`);
      workerStatuses[workerId].transferLogs!.unshift({
        time: new Date().toLocaleTimeString('th-TH'),
        type: 'info',
        message: `Smart Sync: พบตารางที่มีการเปลี่ยนแปลง ${changedTables.length}/${allTableNames.length} ตาราง`
      });
    }

    // For IPD: Determine AN filtering strategy based on source
    let globalIpdMinAn: string | null = null;
    if (type === 'ipd' && source === 'scheduler') {
      globalIpdMinAn = await postgres.getMinAnFromAnStat(ipdDaysBack);
      if (globalIpdMinAn) {
        logger.info(`[${workerId}] IPD: Default MIN(an) for ${ipdDaysBack} days = ${globalIpdMinAn}`);
        workerStatuses[workerId].transferLogs!.unshift({
          time: new Date().toLocaleTimeString('th-TH'),
          type: 'info',
          message: `IPD: ค่าตั้งต้น AN ต่ำสุด (${ipdDaysBack} วันย้อนหลัง) = ${globalIpdMinAn}`
        });
      } else {
        logger.warn(`[${workerId}] IPD: Could not find min AN from an_stat (global)`);
      }
    } else if (type === 'ipd' && source === 'manual' && from) {
      const rangeDesc = to && to !== from ? `AN BETWEEN '${from}' AND '${to}'` : `AN LIKE '${from}%'`;
      logger.info(`[${workerId}] IPD Manual: Using AN range ${rangeDesc}`);
      workerStatuses[workerId].transferLogs!.unshift({
        time: new Date().toLocaleTimeString('th-TH'),
        type: 'info',
        message: `IPD: ดึงตามช่วง AN ที่กำหนด (${rangeDesc})`
      });
    }

    workerStatuses[workerId].totalTables = tablesToTransfer.length;
    workerStatuses[workerId].tableStatuses = {};
    const results: TableTransferResult[] = [];
    const validationResults: ValidationResult[] = [];

    // Setup global concurrency limit for parallel processing across workers
    // HARD LIMIT to 1 globally to prevent 100% CPU spikes and MySQL lock timeouts when multiple workers trigger
    let completedCount = 0;

    const transferTasks = tablesToTransfer.map(table => this.globalTransferLimit(async () => {
      // Check if user requested to stop transfer
      if (workerStatuses[workerId]?.isAborted) {
        logger.warn(`[${workerId}] Skipping table ${table.name} because transfer was stopped by user.`);
        workerStatuses[workerId].tableStatuses[table.name] = 'ไม่สำเร็จ';
        completedCount++;
        workerStatuses[workerId].completedTables = completedCount;
        workerStatuses[workerId].progress = Math.round((completedCount / tablesToTransfer.length) * 100);
        return;
      }

      workerStatuses[workerId].currentTable = table.name;

      // Smart Sync Skip check
      if (changedTableSet && !changedTableSet.has(table.name)) {
        logger.debug(`[${workerId}] ⏭️ [SMART SYNC] ข้ามตาราง '${table.name}' (ไม่มีข้อมูลเปลี่ยนแปลงใน PostgreSQL)`);
        workerStatuses[workerId].tableStatuses[table.name] = 'โอนสำเร็จ';
        results.push({ table: table.name, totalRows: table.rowCount || 0, transferredRows: 0, dryRun });
        completedCount++;
        workerStatuses[workerId].completedTables = completedCount;
        workerStatuses[workerId].progress = Math.round((completedCount / tablesToTransfer.length) * 100);
        return;
      }

      workerStatuses[workerId].tableStatuses[table.name] = 'กำลังโอน';

      // Determine table-specific IPD configurations
      let currentIpdMinAn = globalIpdMinAn;
      let currentIpdDaysBack = ipdDaysBack;

      if (type === 'ipd' && source === 'scheduler' && table.config?.daysBack !== undefined) {
        currentIpdDaysBack = table.config.daysBack;
        // Fetch specific min AN for this table's defined daysBack
        currentIpdMinAn = await postgres.getMinAnFromAnStat(currentIpdDaysBack);
        logger.info(`[${workerId}] IPD Override: ${table.name} mapping ${currentIpdDaysBack} days - MIN(an) = ${currentIpdMinAn}`);
      }
      
      // Retry logic
      let lastError: Error | null = null;
      let success = false;
      
      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        try {
          const t0 = Date.now();
          const tablesConfig = config.getTablesConfig();
          const opdDaysBack = tablesConfig.opd.opdDaysBack || 7;

          const result = await this.transferTable(table, { 
            type, dryRun, from, to, workerId, 
            ipdDaysBack: currentIpdDaysBack, 
            ipdMinAn: currentIpdMinAn,
            opdDaysBack,
            source 
          });
          
          const duration = ((Date.now() - t0) / 1000).toFixed(1);
          logger.info(`[${workerId}] Finished ${table.name} in ${duration}s (${result.transferredRows} rows)`);
          
          // --- Data Integrity Validation ---
          if (!dryRun) {
            try {
              let pgCount = 0;
              let isFiltered = false;
              // If filtering is applied, we count exactly what we query, otherwise full table count
              if (type === 'ipd' && from && to && table.hasAn) {
                pgCount = await postgres.countRowsWithPrefix(table.name, 'an', from, to);
                isFiltered = true;
              } else if (type === 'ipd' && currentIpdMinAn && table.hasAn) {
                pgCount = await postgres.countRowsWithPrefix(table.name, 'an', currentIpdMinAn, undefined);
                isFiltered = true;
              } else if (type === 'opd' && from && to && table.hasVn) {
                pgCount = await postgres.countRowsWithPrefix(table.name, 'vn', from, to);
                isFiltered = true;
              } else if (type === 'opd' && from && table.hasVn) {
                pgCount = await postgres.countRowsWithPrefix(table.name, 'vn', from, undefined);
                isFiltered = true;
              } else {
                pgCount = await postgres.countRows(table.name);
              }
              
              const mysqlCount = await mysqlConnector.countRows(table.name);
              
              // For filtered (incremental) transfers: validate transferredRows matches pgCount
              // For full sync: compare pgCount vs mysqlCount (total table counts)
              let isMatch: boolean;
              if (isFiltered) {
                // Incremental: did we transfer the expected number of rows?
                isMatch = Math.abs(result.transferredRows - pgCount) < 10;
              } else {
                // Full sync: MySQL should have roughly the same as PG
                isMatch = Math.abs(pgCount - mysqlCount) < 10;
              }
              
              validationResults.push({
                table: table.name,
                pgCount,
                mysqlCount,
                isMatch
              });
              
              if (!isMatch) {
                const detail = isFiltered
                  ? `โอน ${result.transferredRows.toLocaleString()} vs ต้นทาง ${pgCount.toLocaleString()} แถว`
                  : `ต้นทาง ${pgCount.toLocaleString()} vs ปลายทาง ${mysqlCount.toLocaleString()} แถว`;
                logger.warn(`[${workerId}] Validation mismatch for ${table.name}: ${detail}`);
                if (workerStatuses[workerId]) {
                  workerStatuses[workerId].transferLogs!.unshift({
                    time: new Date().toLocaleTimeString('th-TH'),
                    type: 'warning',
                    table: table.name,
                    message: `⚠️ ${detail}`
                  });
                }
              }
            } catch (valErr) {
              logger.error(`Validation error for ${table.name}:`, valErr);
            }
          }
          // ---------------------------------
          
          results.push(result);
          workerStatuses[workerId].tableStatuses[table.name] = 'โอนสำเร็จ';
          
          workerStatuses[workerId].transferLogs = workerStatuses[workerId].transferLogs!.filter(
              l => !(l.type === 'progress' && l.table === table.name)
          );
          workerStatuses[workerId].transferLogs!.unshift({
              time: new Date().toLocaleTimeString('th-TH'),
              type: 'success',
              table: table.name,
              message: `โอนสำเร็จ ${result.transferredRows.toLocaleString()} rows (${duration}s)`
          });

          success = true;
          break; // Stop retrying on success
        } catch (error) {
          lastError = error as Error;
          logger.warn(`[${workerId}] Attempt ${attempt} failed for table ${table.name}: ${lastError.message}`);
          
          if (attempt <= MAX_RETRIES) {
            const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
            logger.info(`[${workerId}] Waiting ${delayMs}ms before retry...`);

            workerStatuses[workerId].transferLogs = workerStatuses[workerId].transferLogs!.filter(
                l => !(l.type === 'progress' && l.table === table.name)
            );
            workerStatuses[workerId].transferLogs!.unshift({
                time: new Date().toLocaleTimeString('th-TH'),
                type: 'warning',
                table: table.name,
                message: `ล้มเหลว (ครั้งที่ ${attempt}/${MAX_RETRIES + 1}) กำลัง retry...`
            });
            await delay(delayMs);
          }
        }
      }

      if (!success) {
        logger.error(`[${workerId}] Transfer failed for table ${table.name} after ${MAX_RETRIES + 1} attempts`, { error: lastError });
        workerStatuses[workerId].tableStatuses[table.name] = 'ไม่สำเร็จ';
        workerStatuses[workerId].errors.push({ table: table.name, error: lastError?.message || 'Unknown error' });
        
        workerStatuses[workerId].transferLogs = workerStatuses[workerId].transferLogs!.filter(
            l => !(l.type === 'progress' && l.table === table.name)
        );
        workerStatuses[workerId].transferLogs!.unshift({
            time: new Date().toLocaleTimeString('th-TH'),
            type: 'error',
            table: table.name,
            message: `${lastError?.message || 'Unknown error'} (หลัง retry)`
        });

        // Asynchronous AI Diagnosis
        aiDiagnoser.diagnoseError(lastError?.message || 'Unknown error', table.name).then(diagnosis => {
            logger.info(`[AI DIAGNOSIS] Table ${table.name}: ${diagnosis.errorSummary}`);
            workerStatuses[workerId].transferLogs!.unshift({
                time: new Date().toLocaleTimeString('th-TH'),
                type: 'warning',
                table: table.name,
                message: `🤖 [AI Diagnostic] ${diagnosis.errorSummary} (แนะนำ: ${diagnosis.suggestedAction || diagnosis.recommendations[0]})`
            });
        }).catch(() => {});
      }

      completedCount++;
      workerStatuses[workerId].completedTables = completedCount;
      workerStatuses[workerId].progress = Math.round((completedCount / tablesToTransfer.length) * 100);
      
    }));

    // Wait for all current transfers to complete
    await Promise.all(transferTasks);

    // Update PostgreSQL change detection snapshot for transferred tables
    await pgChangeDetector.updateSnapshot(tablesToTransfer.map(t => t.name));

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const totalRows = results.reduce((sum, r) => sum + r.transferredRows, 0);
    
    logger.info(`[${workerId}] ${type} transfer completed`, { 
      tables: tablesToTransfer.length, 
      duration: `${duration}s`,
      errors: workerStatuses[workerId].errors.length 
    });

    // Save to history
    try {
      transferHistory.save({
        type,
        source: source as 'manual' | 'scheduler',
        workerId,
        totalTables: workerStatuses[workerId].totalTables,
        successTables: workerStatuses[workerId].completedTables,
        failedTables: workerStatuses[workerId].errors.length,
        totalRows,
        duration: `${duration}s`,
        errors: workerStatuses[workerId].errors,
        validation: validationResults,
        tableResults: results,
      });
    } catch (histErr) {
      logger.error('Failed to save transfer history', { error: (histErr as Error).message });
    }
    
    // Add summary log
    const time = new Date().toLocaleTimeString('th-TH');
    const hasErrors = workerStatuses[workerId].errors.length > 0;
    
    const summaryType = type.charAt(0).toUpperCase() + type.slice(1);
    const errorText = hasErrors 
      ? `⚠️ มีปัญหา: ${workerStatuses[workerId].errors.length} ตาราง (${workerStatuses[workerId].errors[0].table})`
      : `⚠️ มีปัญหา: 0 ตาราง`;

    const summaryText = `═════════════════════════════════\n📋 สรุป ${summaryType} Transfer\n✅ สำเร็จ: ${workerStatuses[workerId].completedTables}/${workerStatuses[workerId].totalTables} ตาราง\n${errorText}\n📊 รวม: ${totalRows.toLocaleString()} rows\n⏱️ ใช้เวลา: ${duration} วินาที\n═════════════════════════════════`;

    workerStatuses[workerId].transferLogs!.unshift({
      time,
      type: hasErrors ? 'warning' : 'success',
      message: summaryText
    });

    transferResult = {
      success: true,
      type,
      workerId,
      tablesTransferred: workerStatuses[workerId].completedTables,
      totalTables: workerStatuses[workerId].totalTables,
      duration: `${duration}s`,
      errors: workerStatuses[workerId].errors,
      results,
    };

    // Send Telegram Notification
    if (!dryRun) {
      try {
        const typeEmoji = type === 'basic' ? '🗄️' : type === 'opd' ? '🏥' : '🛌';
        const sourceEmoji = source === 'scheduler' ? '⏰' : '👤';
        const statusEmoji = transferResult.errors.length > 0 ? '⚠️' : '✅';
        
        let message = `${statusEmoji} <b>Task Transfer Completed</b>\n\n`;
        message += `<b>Type:</b> ${typeEmoji} ${type.toUpperCase()}\n`;
        message += `<b>Trigger:</b> ${sourceEmoji} ${source}\n`;
        message += `<b>Duration:</b> ⏱️ ${transferResult.duration}\n\n`;
        message += `<b>Success:</b> ${transferResult.tablesTransferred}/${transferResult.totalTables} tables\n`;
        message += `<b>Rows:</b> ${totalRows.toLocaleString()} rows\n`; // Use totalRows calculated before finally block
        
        if (transferResult.errors.length > 0) {
          message += `\n❌ <b>Failed Tables:</b> ${transferResult.errors.length}\n`;
          message += `<code>${transferResult.errors.map(e => e.table).join(', ')}</code>`;
        }
        
        // Background send (no await to prevent blocking the response)
        sendTelegramMessage(message).catch(err => 
          logger.error(`Failed to send Telegram notification: ${err.message}`)
        );
      } catch (notifyErr) {
        logger.error(`Error constructing Telegram message: ${(notifyErr as Error).message}`);
      }
    }

    } finally {
      workerStatuses[workerId].isRunning = false;
      workerStatuses[workerId].currentRecords = workerStatuses[workerId].totalRecords;
      // Schedule cleanup of heavy data after transfer completes
      this.scheduleWorkerCleanup(workerId);
    }

    return transferResult;
  }

  private async cleanupOrphans(
    tableName: string, 
    pkColumn: string, 
    filterCol: string, 
    from: string | null, 
    to: string | null, 
    useRange: boolean = false
  ): Promise<number> {
    if (tableName.toLowerCase() === 'sys_var') {
      return 0; // Protect sys_var from deletion
    }

    let pgCondition = '';
    let pgParams: any[] = [];
    let mysqlCondition = '';
    let mysqlParams: any[] = [];
    
    if (useRange && from && to) {
      pgCondition = `CAST(${filterCol} AS TEXT) >= $1 AND CAST(${filterCol} AS TEXT) <= $2`;
      pgParams = [from, to];
      mysqlCondition = `\`${filterCol}\` >= ? AND \`${filterCol}\` <= ?`;
      mysqlParams = [from, to];
    } else if (!useRange && from && to && from !== to) {
      pgCondition = `CAST(${filterCol} AS TEXT) >= $1 AND CAST(${filterCol} AS TEXT) < $2`;
      pgParams = [from, to + 'z'];
      mysqlCondition = `\`${filterCol}\` >= ? AND \`${filterCol}\` < ?`;
      mysqlParams = [from, to + 'z'];
    } else if (from) {
      const prefix = from;
      pgCondition = `CAST(${filterCol} AS TEXT) LIKE $1`;
      pgParams = [prefix + '%'];
      mysqlCondition = `\`${filterCol}\` LIKE ?`;
      mysqlParams = [prefix + '%'];
    } else {
       return 0; // No filter, no cleanup
    }
    
    try {
      const pgSet = await postgres.getPrimaryKeys(tableName, pkColumn, pgCondition, pgParams);
      const mySet = await mysqlConnector.getPrimaryKeys(tableName, pkColumn, mysqlCondition, mysqlParams);
      
      const idsToDelete = Array.from(mySet).filter(id => !pgSet.has(id));
      
      if (idsToDelete.length > 0) {
        return await mysqlConnector.deleteBatch(tableName, pkColumn, idsToDelete);
      }
    } catch(err) {
      logger.warn(`Orphan cleanup failed for ${tableName}: ${(err as Error).message}`);
    }
    
    return 0;
  }

  private async transferTable(
    table: ClassifiedTable, 
    options: { type: TransferType; dryRun: boolean; from: string | null; to: string | null; workerId: string; ipdDaysBack: number; ipdMinAn: string | null; opdDaysBack?: number; source?: string }
  ): Promise<TableTransferResult> {
    const { type, dryRun, from, to, workerId, ipdMinAn, opdDaysBack = 7, source } = options;
    
    const dynamicParams = this.getDynamicTransferParams();
    
    // Adaptive Transfer Speed: Fast mode for initial transfer (empty MySQL table), gentle mode for incremental sync
    const mysqlRowCount = await mysqlConnector.countRows(table.name).catch(() => 0);
    const isInitialTransfer = mysqlRowCount === 0;
    
    const batchSize = isInitialTransfer ? Math.max(dynamicParams.batchSize, 2000) : dynamicParams.batchSize;
    const currentThrottleMs = isInitialTransfer ? Math.min(dynamicParams.throttleMs, 20) : dynamicParams.throttleMs;
    
    // Helper to add log entry
    const MAX_LOGS = 200;
    const addLog = (message: string, logType: 'info' | 'success' | 'warning' | 'error' | 'progress' = 'info', rows?: { current: number; total: number }): void => {
      if (workerStatuses[workerId]) {
        const time = new Date().toLocaleTimeString('th-TH');
        
        // Use filtering to keep only the latest 'progress' log per table, preventing log spam
        if (logType === 'progress') {
          workerStatuses[workerId].transferLogs = workerStatuses[workerId].transferLogs!.filter(
            log => !(log.type === 'progress' && log.table === table.name)
          );
        }
        
        workerStatuses[workerId].transferLogs!.unshift({
          time,
          type: logType,
          table: table.name,
          message,
          ...(rows ? { rows } : {})
        });
        
        // Cap logs to prevent memory leak on long-running transfers
        if (workerStatuses[workerId].transferLogs!.length > MAX_LOGS) {
          workerStatuses[workerId].transferLogs = workerStatuses[workerId].transferLogs!.slice(0, MAX_LOGS);
        }
      }
    };
    
    addLog(`เริ่มโอน: ${table.name}`);
    logger.info(`[${workerId}] Transferring table: ${table.name}`);

    // Sync table schema - add any missing columns from PostgreSQL
    const columns = await postgres.getTableColumns(table.name);
    await mysqlConnector.syncTableSchema(table.name, columns);

    let totalRows = 0;
    let transferredRows = 0;

    // Enable bulk session optimizations (session-level, won't affect other connections)
    if (!dryRun) {
      try {
        await mysqlConnector.ensureTableCharset(table.name);
        await mysqlConnector.ensureIndexes(table.name, table.hasVn, table.hasAn);
        await mysqlConnector.beginBulkSession();
      } catch {
        // Ignore if session settings fail
      }
    }

    try {

    if (type === 'basic') {
      // Basic tables: use upsert if PK exists (preserves MySQL-only columns), 
      // otherwise fall back to truncate+insert
      const keyColumns = await postgres.getPrimaryKey(table.name);
      const useUpsert = keyColumns.length > 0;

      if (!useUpsert) {
        // No PK: must truncate+insert (upsert requires a unique key)
        if (!dryRun) {
          await mysqlConnector.truncateTable(table.name);
        }
        addLog(`ไม่มี Primary Key - ใช้ truncate+insert`);
      } else {
        addLog(`ใช้ upsert (PK: ${keyColumns.join(', ')})`);
      }

      totalRows = await postgres.countRows(table.name);
      workerStatuses[workerId].totalRecords = totalRows;
      workerStatuses[workerId].currentRecords = 0;
      addLog(`พบ ${totalRows.toLocaleString()} records`);
      
      let offset = 0;

      while (offset < totalRows) {
        const rows = await postgres.fetchData(table.name, batchSize, offset);
        if (rows.length === 0) break;

        if (!dryRun) {
          if (useUpsert) {
            await mysqlConnector.upsertBatch(table.name, rows, keyColumns);
          } else {
            await mysqlConnector.insertBatch(table.name, rows);
          }
          // Throttle: give MySQL breathing room for other apps
          if (currentThrottleMs > 0) await delay(currentThrottleMs);
        }
        
        transferredRows += rows.length;
        workerStatuses[workerId].currentRecords = transferredRows;
        
        // Log every batch
        addLog(`${transferredRows.toLocaleString()} / ${totalRows.toLocaleString()} records`, 'progress', { current: transferredRows, total: totalRows });
        
        offset += batchSize;
      }
    } else if (type === 'opd') {
      const useMinLabOrderNumber = table.config?.useMinLabOrderNumber || table.name === 'lab_order';
      const hasFilter = from && table.hasVn;
      
      if (useMinLabOrderNumber) {
        let filterDesc = '';
        const daysBack = table.config?.daysBack || opdDaysBack || 7;

        if (from) {
          filterDesc = (from && to && from !== to) 
            ? `vn BETWEEN '${from}' AND '${to}'`
            : `vn LIKE '${from}%'`;
          totalRows = await postgres.countLabOrderRowsByVnPrefix(table.name, from, to || undefined);
        } else {
          filterDesc = `ย้อนหลัง ${daysBack} วัน`;
          totalRows = await postgres.countLabOrderRowsByDaysBack(table.name, daysBack);
        }

        workerStatuses[workerId].totalRecords = totalRows;
        workerStatuses[workerId].currentRecords = 0;
        addLog(`พบ ${totalRows.toLocaleString()} records (${filterDesc})`);

        if (totalRows === 0) {
          addLog(`ไม่มีข้อมูลที่ตรงเงื่อนไข`);
        } else {
          let offset = 0;
          const keyColumns = await postgres.getPrimaryKey(table.name);

          while (offset < totalRows) {
            const rows = from 
              ? await postgres.fetchLabOrderDataByVnPrefix(table.name, from, to || undefined, batchSize, offset)
              : await postgres.fetchLabOrderDataByDaysBack(table.name, daysBack, batchSize, offset);
            if (rows.length === 0) break;

            if (!dryRun) {
              if (keyColumns.length > 0) {
                await mysqlConnector.upsertBatch(table.name, rows, keyColumns);
              } else {
                await mysqlConnector.insertBatch(table.name, rows);
              }
              if (currentThrottleMs > 0) await delay(currentThrottleMs);
            }

            transferredRows += rows.length;
            workerStatuses[workerId].currentRecords = transferredRows;
            addLog(`${table.name}: ${transferredRows.toLocaleString()} / ${totalRows.toLocaleString()} records`, 'progress', { current: transferredRows, total: totalRows });

            offset += batchSize;
          }
        }
      } else if (hasFilter) {
        // Use VN prefix filter
        totalRows = await postgres.countRowsWithPrefix(table.name, 'vn', from, to || undefined);
        workerStatuses[workerId].totalRecords = totalRows;
        workerStatuses[workerId].currentRecords = 0;
        
        // Show correct log message based on query type
        const filterDesc = (from && to && from !== to) 
          ? `vn BETWEEN '${from}' AND '${to}'`
          : `vn LIKE '${from}%'`;
        addLog(`พบ ${totalRows.toLocaleString()} records (${filterDesc})`);
        
        if (totalRows === 0) {
          addLog(`ไม่มีข้อมูลที่ตรงเงื่อนไข`);
        } else {
          let offset = 0;
          const keyColumns = await postgres.getPrimaryKey(table.name);
          
          if (source === 'manual' && keyColumns.length === 1 && !dryRun) {
            addLog(`กำลังคัดกรองข้อมูลส่วนเกิน (Orphan Cleanup)...`);
            const deleted = await this.cleanupOrphans(table.name, keyColumns[0], 'vn', from, to || null, false);
            if (deleted > 0) {
              addLog(`ลบ orphan rows สำเร็จ: ${deleted.toLocaleString()} rows`, 'success');
            } else {
              addLog(`ไม่พบข้อมูลส่วนเกิน`);
            }
          }
          
          while (offset < totalRows) {
            const rows = await postgres.fetchDataWithPrefix(table.name, 'vn', from, to || undefined, batchSize, offset);
            if (rows.length === 0) break;
            
            if (!dryRun) {
              if (keyColumns.length > 0) {
                await mysqlConnector.upsertBatch(table.name, rows, keyColumns);
              } else {
                await mysqlConnector.insertBatch(table.name, rows);
              }
              // Throttle: give MySQL breathing room for other apps
              if (currentThrottleMs > 0) await delay(currentThrottleMs);
            }
            
            transferredRows += rows.length;
            workerStatuses[workerId].currentRecords = transferredRows;
            addLog(`${table.name}: ${transferredRows.toLocaleString()} / ${totalRows.toLocaleString()} records`, 'progress', { current: transferredRows, total: totalRows });
            
            offset += batchSize;
          }
        }
      } else {
        // No filter, do full sync with upsert
        totalRows = await postgres.countRows(table.name);
        workerStatuses[workerId].totalRecords = totalRows;
        workerStatuses[workerId].currentRecords = 0;
        addLog(`${table.name}: พบ ${totalRows.toLocaleString()} records (ทั้งหมด)`);
        
        let offset = 0;
        const keyColumns = await postgres.getPrimaryKey(table.name);
        
        while (offset < totalRows) {
          const rows = await postgres.fetchData(table.name, batchSize, offset);
          if (rows.length === 0) break;
          
          if (!dryRun) {
            if (keyColumns.length > 0) {
              await mysqlConnector.upsertBatch(table.name, rows, keyColumns);
            } else {
              await mysqlConnector.insertBatch(table.name, rows);
            }
            // Throttle: give MySQL breathing room for other apps
            if (currentThrottleMs > 0) await delay(currentThrottleMs);
          }
          
          transferredRows += rows.length;
          workerStatuses[workerId].currentRecords = transferredRows;
          addLog(`${table.name}: ${transferredRows.toLocaleString()} / ${totalRows.toLocaleString()} records`, 'progress', { current: transferredRows, total: totalRows });
          
          offset += batchSize;
        }
      }
    } else if (type === 'ipd') {
      const parentLink = IPD_PARENT_LINKS[table.name];
      
      if (table.hasAn && from) {
        // Mode 1: Manual - use AN prefix range (like OPD uses VN prefix)
        totalRows = await postgres.countRowsWithPrefix(table.name, 'an', from, to || undefined);
        workerStatuses[workerId].totalRecords = totalRows;
        workerStatuses[workerId].currentRecords = 0;
        
        const filterDesc = (from && to && from !== to) 
          ? `an BETWEEN '${from}' AND '${to}'`
          : `an LIKE '${from}%'`;
        addLog(`พบ ${totalRows.toLocaleString()} records (${filterDesc})`);
        
        if (totalRows === 0) {
          addLog(`ไม่มีข้อมูลที่ตรงเงื่อนไข`);
        } else {
          let offset = 0;
          const keyColumns = await postgres.getPrimaryKey(table.name);

          if (source === 'manual' && keyColumns.length === 1 && !dryRun) {
            addLog(`กำลังคัดกรองข้อมูลส่วนเกิน (Orphan Cleanup)...`);
            const deleted = await this.cleanupOrphans(table.name, keyColumns[0], 'an', from, to || null, false);
            if (deleted > 0) {
              addLog(`ลบ orphan rows สำเร็จ: ${deleted.toLocaleString()} rows`, 'success');
            } else {
              addLog(`ไม่พบข้อมูลส่วนเกิน`);
            }
          }
          
          while (offset < totalRows) {
            const rows = await postgres.fetchDataWithPrefix(table.name, 'an', from, to || undefined, batchSize, offset);
            if (rows.length === 0) break;
            
            if (!dryRun) {
              if (keyColumns.length > 0) {
                await mysqlConnector.upsertBatch(table.name, rows, keyColumns);
              } else {
                await mysqlConnector.insertBatch(table.name, rows);
              }
            }
            
            transferredRows += rows.length;
            workerStatuses[workerId].currentRecords = transferredRows;
            addLog(`${table.name}: ${transferredRows.toLocaleString()} / ${totalRows.toLocaleString()} records`, 'progress', { current: transferredRows, total: totalRows });
            
            offset += batchSize;
          }
        }
      } else if (!table.hasAn && parentLink && from) {
        // Mode 1b: Manual Detail - use parent AN subquery
        totalRows = await postgres.countRowsByParentAn(
          table.name, parentLink.parentTable, parentLink.fkColumn, from, to || undefined,
          parentLink.grandparentTable, parentLink.grandparentFkColumn
        );
        workerStatuses[workerId].totalRecords = totalRows;
        workerStatuses[workerId].currentRecords = 0;

        const filterDesc = (from && to && from !== to) 
          ? `an BETWEEN '${from}' AND '${to}' (ผ่าน ${parentLink.parentTable})`
          : `an LIKE '${from}%' (ผ่าน ${parentLink.parentTable})`;
        addLog(`พบ ${totalRows.toLocaleString()} records (${filterDesc})`);

        if (totalRows === 0) {
          addLog(`ไม่มีข้อมูลที่ตรงเงื่อนไข`);
        } else {
          let offset = 0;
          const keyColumns = await postgres.getPrimaryKey(table.name);

          while (offset < totalRows) {
            const rows = await postgres.fetchDataByParentAn(
              table.name, parentLink.parentTable, parentLink.fkColumn, from, to || undefined,
              batchSize, offset, parentLink.grandparentTable, parentLink.grandparentFkColumn
            );
            if (rows.length === 0) break;

            if (!dryRun) {
              if (keyColumns.length > 0) {
                await mysqlConnector.upsertBatch(table.name, rows, keyColumns);
              } else {
                await mysqlConnector.insertBatch(table.name, rows);
              }
              if (currentThrottleMs > 0) await delay(currentThrottleMs);
            }

            transferredRows += rows.length;
            workerStatuses[workerId].currentRecords = transferredRows;
            addLog(`${table.name}: ${transferredRows.toLocaleString()} / ${totalRows.toLocaleString()} records`, 'progress', { current: transferredRows, total: totalRows });

            offset += batchSize;
          }
        }
      } else if (table.hasAn && ipdMinAn) {
        // Mode 2: Scheduler - use pre-fetched min AN from an_stat
        totalRows = await postgres.countRowsByAnRange(table.name, ipdMinAn);
        workerStatuses[workerId].totalRecords = totalRows;
        workerStatuses[workerId].currentRecords = 0;
        addLog(`${table.name}: พบ ${totalRows.toLocaleString()} records (AN >= '${ipdMinAn}')`);
        
        if (totalRows > 0) {
          let offset = 0;
          const keyColumns = await postgres.getPrimaryKey(table.name);
          
          while (offset < totalRows) {
            const rows = await postgres.fetchDataByAnRange(table.name, ipdMinAn, batchSize, offset);
            if (rows.length === 0) break;
            
            if (!dryRun) {
              if (keyColumns.length > 0) {
                await mysqlConnector.upsertBatch(table.name, rows, keyColumns);
              } else {
                await mysqlConnector.insertBatch(table.name, rows);
              }
              // Throttle: give MySQL breathing room for other apps
              if (currentThrottleMs > 0) await delay(currentThrottleMs);
            }
            
            transferredRows += rows.length;
            workerStatuses[workerId].currentRecords = transferredRows;
            addLog(`${table.name}: ${transferredRows.toLocaleString()} / ${totalRows.toLocaleString()} records`, 'progress', { current: transferredRows, total: totalRows });
            
            offset += batchSize;
          }
        }
      } else if (!table.hasAn && parentLink && ipdMinAn) {
        // Mode 2b: Scheduler Detail - use parent min AN subquery
        totalRows = await postgres.countRowsByParentMinAn(
          table.name, parentLink.parentTable, parentLink.fkColumn, ipdMinAn,
          parentLink.grandparentTable, parentLink.grandparentFkColumn
        );
        workerStatuses[workerId].totalRecords = totalRows;
        workerStatuses[workerId].currentRecords = 0;
        addLog(`${table.name}: พบ ${totalRows.toLocaleString()} records (AN >= '${ipdMinAn}' ผ่าน ${parentLink.parentTable})`);

        if (totalRows > 0) {
          let offset = 0;
          const keyColumns = await postgres.getPrimaryKey(table.name);

          while (offset < totalRows) {
            const rows = await postgres.fetchDataByParentMinAn(
              table.name, parentLink.parentTable, parentLink.fkColumn, ipdMinAn,
              batchSize, offset, parentLink.grandparentTable, parentLink.grandparentFkColumn
            );
            if (rows.length === 0) break;

            if (!dryRun) {
              if (keyColumns.length > 0) {
                await mysqlConnector.upsertBatch(table.name, rows, keyColumns);
              } else {
                await mysqlConnector.insertBatch(table.name, rows);
              }
              if (currentThrottleMs > 0) await delay(currentThrottleMs);
            }

            transferredRows += rows.length;
            workerStatuses[workerId].currentRecords = transferredRows;
            addLog(`${table.name}: ${transferredRows.toLocaleString()} / ${totalRows.toLocaleString()} records`, 'progress', { current: transferredRows, total: totalRows });

            offset += batchSize;
          }
        }
      } else {
        // Mode 3: Full sync fallback
        if (!table.hasAn) {
          addLog(`${table.name}: ไม่มี AN column, โอนข้อมูลทั้งหมด`);
        } else {
          addLog(`${table.name}: ไม่มีเงื่อนไข AN, โอนข้อมูลทั้งหมด`);
        }
        
        totalRows = await postgres.countRows(table.name);
        workerStatuses[workerId].totalRecords = totalRows;
        workerStatuses[workerId].currentRecords = 0;
        addLog(`${table.name}: พบ ${totalRows.toLocaleString()} records (ทั้งหมด)`);
        
        let offset = 0;
        const keyColumns = await postgres.getPrimaryKey(table.name);
        
        while (offset < totalRows) {
          const rows = await postgres.fetchData(table.name, batchSize, offset);
          if (rows.length === 0) break;
          
          if (!dryRun) {
            if (keyColumns.length > 0) {
              await mysqlConnector.upsertBatch(table.name, rows, keyColumns);
            } else {
              await mysqlConnector.insertBatch(table.name, rows);
            }
            // Throttle: give MySQL breathing room for other apps
            if (currentThrottleMs > 0) await delay(currentThrottleMs);
          }
          
          transferredRows += rows.length;
          workerStatuses[workerId].currentRecords = transferredRows;
          addLog(`${table.name}: ${transferredRows.toLocaleString()} / ${totalRows.toLocaleString()} records`, 'progress', { current: transferredRows, total: totalRows });
          
          offset += batchSize;
        }
      }
    }

    } finally {
      // End bulk session optimizations
      if (!dryRun) {
        try {
          await mysqlConnector.endBulkSession();
        } catch {
          // Ignore if session reset fails
        }
      }
    }

    addLog(`โอนสำเร็จ: ${table.name} (${transferredRows.toLocaleString()} records)`);

    logger.info(`[${workerId}] Completed: ${table.name}`, { totalRows, transferredRows, dryRun });

    return {
      table: table.name,
      totalRows,
      transferredRows,
      dryRun,
    };
  }

  getIncrementalColumn(table: ClassifiedTable, type: TransferType): string | null {
    const columnNames = table.columns.map(c => c.column_name.toLowerCase());
    
    if (columnNames.includes('updated_at')) return 'updated_at';
    if (columnNames.includes('created_at')) return 'created_at';
    if (type === 'opd' && columnNames.includes('vn')) return 'vn';
    if (type === 'ipd' && columnNames.includes('an')) return 'an';
    
    return null;
  }

  async transferAll(options: TransferOptions = {}): Promise<{
    basic: TransferResult | null;
    opd: TransferResult | null;
    ipd: TransferResult | null;
  }> {
    const results = {
      basic: null as TransferResult | null,
      opd: null as TransferResult | null,
      ipd: null as TransferResult | null,
    };

    results.basic = await this.transfer('basic', options);
    results.opd = await this.transfer('opd', options);
    results.ipd = await this.transfer('ipd', options);

    return results;
  }
}

export default new TransferEngine();
