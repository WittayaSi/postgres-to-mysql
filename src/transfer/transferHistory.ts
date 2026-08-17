import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { TransferHistoryRecord, TransferStats, TransferType, TransferError, TableTransferResult, ValidationResult } from '../types';

const DATA_DIR = path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'transfer-history.json');
const MAX_RECORDS = 200;

class TransferHistory {
  private records: TransferHistoryRecord[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(HISTORY_FILE)) {
        const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
        const parsed = JSON.parse(data) as TransferHistoryRecord[];
        // Trim heavy data from in-memory records (full data stays in JSON file)
        this.records = parsed.map(r => this.trimForMemory(r));
      }
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to load transfer history', { error: err.message });
      this.records = [];
    }
  }

  private persist(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.records, null, 2));
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to save transfer history', { error: err.message });
    }
  }

  save(record: {
    type: TransferType;
    source: 'manual' | 'scheduler';
    workerId: string;
    totalTables: number;
    successTables: number;
    failedTables: number;
    totalRows: number;
    duration: string;
    errors: TransferError[];
    validation: ValidationResult[];
    tableResults: TableTransferResult[];
  }): TransferHistoryRecord {
    const entry: TransferHistoryRecord = {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      ...record,
    };

    // Add to beginning (newest first)
    this.records.unshift(entry);

    // Prune old records
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(0, MAX_RECORDS);
    }

    this.persist();
    logger.info(`Transfer history saved: ${entry.id}`, {
      type: entry.type,
      success: entry.successTables,
      failed: entry.failedTables,
      rows: entry.totalRows,
    });

    return entry;
  }

  /**
   * Strip heavy data (tableResults, validation) from in-memory record.
   * Full data is persisted to JSON file and can be read on-demand.
   */
  private trimForMemory(record: TransferHistoryRecord): TransferHistoryRecord {
    return {
      ...record,
      tableResults: [],
      validation: [],
    };
  }

  getAll(limit: number = 20, offset: number = 0): { records: TransferHistoryRecord[]; total: number } {
    return {
      records: this.records.slice(offset, offset + limit),
      total: this.records.length,
    };
  }

  getById(id: string): TransferHistoryRecord | null {
    // Try in-memory first (trimmed), then load full record from file for detail view
    const memRecord = this.records.find(r => r.id === id);
    if (!memRecord) return null;
    
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
        const allRecords = JSON.parse(data) as TransferHistoryRecord[];
        return allRecords.find(r => r.id === id) || memRecord;
      }
    } catch {
      // Fallback to in-memory (trimmed) version
    }
    return memRecord;
  }

  getStats(): TransferStats {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const todayRecords = this.records.filter(r => r.timestamp.startsWith(today));

    return {
      todayTransfers: todayRecords.length,
      todaySuccess: todayRecords.filter(r => r.failedTables === 0).length,
      todayFailed: todayRecords.filter(r => r.failedTables > 0).length,
      todayRows: todayRecords.reduce((sum, r) => sum + r.totalRows, 0),
      totalTransfers: this.records.length,
      lastTransfer: this.records.length > 0 ? this.records[0].timestamp : null,
    };
  }

  getFailedTables(historyId: string): string[] {
    const record = this.getById(historyId);
    if (!record) return [];
    return record.errors.map(e => e.table);
  }

  private generateId(): string {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${dateStr}-${rand}`;
  }
}

export default new TransferHistory();
