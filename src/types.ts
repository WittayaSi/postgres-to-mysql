// Database Configuration Types
export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface MySQLConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface DatabaseConfig {
  postgres: PostgresConfig;
  mysql: MySQLConfig;
}

// Table Structure Types
export interface TableColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

export interface ClassifiedTable {
  name: string;
  columns: TableColumn[];
  hasVn: boolean;
  hasAn: boolean;
  rowCount: number;
  config?: TableSpecificConfig; // Table-level specific configuration
}

export interface ClassifiedTables {
  basic: ClassifiedTable[];
  opd: ClassifiedTable[];
  ipd: ClassifiedTable[];
}

export interface TableSummary {
  basic: { count: number; tables: string[] };
  opd: { count: number; tables: string[] };
  ipd: { count: number; tables: string[] };
}

// Tables Configuration Types
export interface TableFilter {
  include: string[];
  exclude: string[];
}

export interface TableSpecificConfig {
  daysBack?: number;
  skipOrphanCleanup?: boolean; // ไม่ลบ orphan rows (แถวที่มีใน MySQL แต่ไม่มีใน PostgreSQL)
  useMinLabOrderNumber?: boolean; // ใช้ min lab_order_number จาก lab_head ตามจำนวนวันย้อนหลัง
}

export interface TableTypeConfig {
  schedule: string;
  enabled: boolean;
  description?: string;
  opdDaysBack?: number;
  ipdDaysBack?: number;
  tables: TableFilter;
  tableConfigs?: Record<string, TableSpecificConfig>;
}

export interface TablesConfig {
  basic: TableTypeConfig;
  opd: TableTypeConfig;
  ipd: TableTypeConfig;
}

// Transfer Types
export type TransferType = 'basic' | 'opd' | 'ipd' | 'all';

// Change Detection Types
export interface PgTableChangeStat {
  tableName: string;
  insertedCount: number;
  updatedCount: number;
  deletedCount: number;
  totalChanges: number;
}

export interface ChangeDetectionResult {
  tableName: string;
  hasChanged: boolean;
  insertedDiff: number;
  updatedDiff: number;
  deletedDiff: number;
  totalChangesDiff: number;
  currentStats: PgTableChangeStat;
}

export interface TransferOptions {
  dryRun?: boolean;
  tables?: string[] | null;
  from?: string | null;
  to?: string | null;
  workerId?: string;
  source?: 'manual' | 'scheduler';
  // IPD: Number of days back for discharge date query
  ipdDaysBack?: number;
  // Smart Sync: Only transfer tables that have changed in Postgres
  smartSync?: boolean;
}

export interface TableTransferResult {
  table: string;
  totalRows: number;
  transferredRows: number;
  dryRun: boolean;
}

export interface TransferResult {
  success: boolean;
  type: TransferType;
  workerId: string;
  tablesTransferred: number;
  totalTables: number;
  duration: string;
  errors: TransferError[];
  results: TableTransferResult[];
}

export interface TransferError {
  table: string;
  error: string;
}

// Worker Status Types
export type TableStatus = 'กำลังโอน' | 'โอนสำเร็จ' | 'ไม่สำเร็จ';

export interface WorkerStatus {
  isRunning: boolean;
  isAborted?: boolean;
  type: TransferType | null;
  currentTable: string | null;
  progress: number;
  totalTables: number;
  completedTables: number;
  currentRecords?: number;
  totalRecords?: number;
  startTime?: string;
  endTime?: string;
  errors: TransferError[];
  workerId: string;
  tableStatuses: Record<string, TableStatus>;
  transferLogs?: { time: string; type: 'info' | 'success' | 'warning' | 'error' | 'progress'; table?: string; message: string; rows?: { current: number; total: number } }[];
  validation?: ValidationResult[];
}

export type WorkerStatuses = Record<string, WorkerStatus>;

// Schedule Types
export interface ScheduleStatus {
  enabled: boolean;
  schedule: string;
  description?: string;
  nextRun: string | null;
}

export interface SchedulerStatus {
  basic: ScheduleStatus;
  opd: ScheduleStatus;
  ipd: ScheduleStatus;
}

// Log Types
export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

// API Types
export interface CheckCountsRequest {
  type: TransferType;
  vnStart?: string;
  vnEnd?: string;
  anStart?: string;
  anEnd?: string;
  tableNames?: string[];
  workerId?: string;
}

export interface CheckCountsResult {
  name: string;
  hasVn: boolean;
  hasAn: boolean;
  rowCount: number;
}

export interface TestConnectionRequest {
  type: 'postgres' | 'mysql';
  config: PostgresConfig | MySQLConfig;
}

// Validation Types
export interface ValidationResult {
  table: string;
  pgCount: number;
  mysqlCount: number;
  isMatch: boolean;
}

// Transfer History Types
export interface TransferHistoryRecord {
  id: string;
  timestamp: string;
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
}

export interface TransferStats {
  todayTransfers: number;
  todaySuccess: number;
  todayFailed: number;
  todayRows: number;
  totalTransfers: number;
  lastTransfer: string | null;
}

// AI Diagnostic & Schema Types
export interface AIDiagnosisResult {
  errorSummary: string;
  category: 'database_connection' | 'primary_key_missing' | 'schema_mismatch' | 'row_size_exceeded' | 'duplicate_entry' | 'syntax_error' | 'unknown';
  rootCause: string;
  recommendations: string[];
  suggestedAction?: string;
  aiProvider: 'gemini' | 'openai' | 'rule_engine';
  timestamp: string;
}

export interface AISchemaTranslation {
  tableName: string;
  pgColumns: TableColumn[];
  recommendedMysqlTypes: Record<string, string>;
  warnings: string[];
  suggestedPrimaryKeys: string[];
  aiProvider: 'gemini' | 'openai' | 'rule_engine';
}

