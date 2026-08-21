import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { withRetry } from '../utils/retry';
import { MySQLConfig, TableColumn, DatabaseConfig } from '../types';

// Helper function to format Date as local datetime (not UTC)
function formatDateForMySQL(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

class MySQLConnector {
  private pool: Pool | null = null;
  private config: MySQLConfig | null = null;
  private bulkSize: number = parseInt(process.env.MYSQL_BULK_SIZE || '50');
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  async connect(customConfig: MySQLConfig | null = null): Promise<Pool> {
    if (this.pool && !customConfig) return this.pool;
    
    const config = customConfig || this.loadConfig();
    this.config = config;
    
    this.pool = mysql.createPool({
      ...config,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 3,  // Keep low to leave connections for other apps
      queueLimit: 0,
      connectTimeout: 10000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
    
    // Test connection and set session charset
    try {
      const connection: PoolConnection = await this.pool.getConnection();
      await connection.query('SELECT 1');
      await connection.query("SET NAMES utf8mb4");
      await connection.query("SET CHARACTER SET utf8mb4");
      connection.release();
      logger.info('MySQL connected successfully (utf8mb4 mode)');
      
      // Start periodic health check (every 5 minutes)
      this.startHealthCheck();
      
      return this.pool;
    } catch (error) {
      const err = error as Error;
      logger.error('MySQL connection failed', { error: err.message });
      throw error;
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (this.pool) {
          const conn = await this.pool.getConnection();
          await conn.query('SELECT 1');
          conn.release();
        }
      } catch (error) {
        const err = error as Error;
        logger.warn(`[HEALTH] MySQL health check failed: ${err.message}, attempting reconnect...`);
        try {
          await this.close();
          await this.connect();
          logger.info('[HEALTH] MySQL reconnected successfully');
        } catch (reconnectErr) {
          logger.error('[HEALTH] MySQL reconnect failed', { error: (reconnectErr as Error).message });
        }
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  private loadConfig(): MySQLConfig {
    return {
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      database: process.env.MYSQL_DATABASE || 'hospital_db',
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
    };
  }

  async reconnect(config: MySQLConfig): Promise<Pool> {
    await this.close();
    this.config = config;
    return this.connect(config);
  }

  async tableExists(tableName: string): Promise<boolean> {
    const pool = await this.connect();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM information_schema.tables 
       WHERE table_schema = ? AND table_name = ?`,
      [this.config!.database, tableName]
    );
    return rows[0].count > 0;
  }

  async createTable(tableName: string, columns: TableColumn[], primaryKey: string[] = []): Promise<void> {
    const pool = await this.connect();
    
    const columnDefs = columns.map(col => {
      // Keep primary key columns as VARCHAR (TEXT cannot be used in PK)
      const isPkColumn = primaryKey.includes(col.column_name);
      const mysqlType = this.mapDataType(col, isPkColumn);
      const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      return `\`${col.column_name}\` ${mysqlType} ${nullable}`;
    }).join(',\n  ');
    
    // Add primary key constraint if exists
    let pkConstraint = '';
    if (primaryKey && primaryKey.length > 0) {
      const pkCols = primaryKey.map(col => `\`${col}\``).join(', ');
      pkConstraint = `,\n  PRIMARY KEY (${pkCols})`;
    }
    
    const sql = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n  ${columnDefs}${pkConstraint}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC`;
    
    await pool.query(sql);
    logger.info(`Created table: ${tableName}${primaryKey.length > 0 ? ' (with PK: ' + primaryKey.join(', ') + ')' : ''}`);
  }

  // Sync table schema - add missing columns from source (PostgreSQL)
  async syncTableSchema(tableName: string, sourceColumns: TableColumn[]): Promise<void> {
    const pool = await this.connect();
    
    // Get existing columns in MySQL
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_schema = ? AND table_name = ?`,
      [this.config!.database, tableName]
    );
    
    const existingColumns = new Set(rows.map(r => r.column_name.toLowerCase()));
    
    // Find missing columns
    const missingColumns = sourceColumns.filter(
      col => !existingColumns.has(col.column_name.toLowerCase())
    );
    
    // Add missing columns
    for (const col of missingColumns) {
      try {
        const mysqlType = this.mapDataType(col);
        const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
        const alterSql = `ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.column_name}\` ${mysqlType} ${nullable}`;
        
        await pool.query(alterSql);
        logger.info(`Added column to ${tableName}: ${col.column_name} (${mysqlType})`);
      } catch (error) {
        const err = error as Error;
        logger.error(`Failed to add column ${col.column_name} to ${tableName}: ${err.message}`);
      }
    }

    // Drop legacy _last_sync column if it exists in MySQL
    if (existingColumns.has('_last_sync')) {
      try {
        await pool.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`_last_sync\``);
        logger.info(`Dropped legacy _last_sync column from ${tableName}`);
      } catch (error) {
        // Ignore if drop fails
      }
    }
  }

  // Drop _last_sync column from ALL tables in target MySQL database
  async dropLastSyncFromAllTables(): Promise<{ droppedCount: number; tables: string[] }> {
    const pool = await this.connect();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT table_name FROM information_schema.columns 
       WHERE table_schema = ? AND column_name = '_last_sync'`,
      [this.config!.database]
    );

    const tables = rows.map(r => r.TABLE_NAME || r.table_name);
    let droppedCount = 0;

    for (const table of tables) {
      try {
        await pool.query(`ALTER TABLE \`${table}\` DROP COLUMN \`_last_sync\``);
        logger.info(`Successfully dropped _last_sync from ${table}`);
        droppedCount++;
      } catch (err) {
        logger.error(`Failed to drop _last_sync from ${table}: ${(err as Error).message}`);
      }
    }

    return { droppedCount, tables };
  }

  // Ensure indexes exist for fast filtering without freezing MySQL
  async ensureIndexes(tableName: string, hasVn: boolean = false, hasAn: boolean = false): Promise<void> {
    try {
      const pool = await this.connect();
      const [indexRows] = await pool.query<RowDataPacket[]>(`SHOW INDEX FROM \`${tableName}\``);
      const existingIndexCols = new Set(indexRows.map(r => r.Column_name.toLowerCase()));

      if (hasVn && !existingIndexCols.has('vn')) {
        try {
          await pool.query(`ALTER TABLE \`${tableName}\` ADD INDEX \`idx_vn\` (\`vn\`(15))`);
          logger.info(`Added index idx_vn on ${tableName}(vn)`);
        } catch (e) {}
      }

      if (hasAn && !existingIndexCols.has('an')) {
        try {
          await pool.query(`ALTER TABLE \`${tableName}\` ADD INDEX \`idx_an\` (\`an\`(15))`);
          logger.info(`Added index idx_an on ${tableName}(an)`);
      }
    } catch (err) {
      // Ignore if index check fails
    }
  }
  async ensureTableCharset(tableName: string): Promise<void> {
    try {
      const pool = await this.connect();
      const [tableInfo] = await pool.query<RowDataPacket[]>(
        `SELECT table_collation 
         FROM information_schema.tables 
         WHERE table_schema = ? AND table_name = ?`,
        [this.config!.database, tableName]
      );
      
      if (tableInfo.length > 0) {
        const collation = (tableInfo[0].table_collation || tableInfo[0].TABLE_COLLATION || '').toLowerCase();
        if (!collation.startsWith('utf8mb4')) {
          await pool.query(`ALTER TABLE \`${tableName}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
          logger.info(`Converted table ${tableName} charset from ${collation} to utf8mb4`);
        }
      }
    } catch (err) {
      // Ignore if table alter fails
    }
  }

  private mapDataType(column: TableColumn, isPkColumn: boolean = false): string {
    const pgType = column.data_type.toLowerCase();
    const length = column.character_maximum_length;
    
    // For primary key columns, use VARCHAR(255) instead of TEXT
    // TEXT columns cannot be used in MySQL primary keys without key length
    if (isPkColumn) {
      if (pgType === 'character varying' || pgType === 'varchar' || pgType === 'text') {
        return `VARCHAR(${Math.min(length || 255, 255)})`;
      }
    }
    
    const typeMap: Record<string, string> = {
      'integer': 'INT',
      'bigint': 'BIGINT',
      'smallint': 'SMALLINT',
      'numeric': `DECIMAL(${column.numeric_precision || 10}, ${column.numeric_scale || 2})`,
      'decimal': `DECIMAL(${column.numeric_precision || 10}, ${column.numeric_scale || 2})`,
      'real': 'FLOAT',
      'double precision': 'DOUBLE',
      // Convert large VARCHAR to TEXT to prevent row size too large error
      'character varying': length && length <= 50 ? `VARCHAR(${length})` : 'TEXT',
      'varchar': length && length <= 50 ? `VARCHAR(${length})` : 'TEXT',
      'character': length ? `CHAR(${Math.min(length, 255)})` : 'CHAR(1)',
      'char': length ? `CHAR(${Math.min(length, 255)})` : 'CHAR(1)',
      'text': 'TEXT',
      'boolean': 'TINYINT(1)',
      'date': 'DATE',
      'time': 'TIME',
      'time without time zone': 'TIME',
      'time with time zone': 'TIME',
      'timestamp': 'DATETIME',
      'timestamp without time zone': 'DATETIME',
      'timestamp with time zone': 'DATETIME',
      'json': 'JSON',
      'jsonb': 'JSON',
      'uuid': 'VARCHAR(36)',
      'bytea': 'BLOB',
    };
    
    return typeMap[pgType] || 'TEXT';
  }

  // Fetch all primary keys for orphan comparison
  async getPrimaryKeys(tableName: string, pkColumn: string, condition?: string, params?: any[]): Promise<Set<string>> {
    const pool = await this.connect();
    
    let query = `SELECT \`${pkColumn}\` as id FROM \`${tableName}\``;
    if (condition) {
      query += ` WHERE ${condition}`;
    }
    
    const [rows] = await pool.query<RowDataPacket[]>(query, params || []);
    const idSet = new Set<string>();
    
    // Convert all IDs to string to ensure consistent comparison across DBs
    for (const row of rows) {
      if (row.id !== null && row.id !== undefined) {
        idSet.add(String(row.id));
      }
    }
    
    return idSet;
  }

  // Delete orphaned rows in chunks
  async deleteBatch(tableName: string, pkColumn: string, idsToDelete: string[]): Promise<number> {
    if (!idsToDelete || idsToDelete.length === 0) return 0;
    
    return withRetry(async () => {
      const pool = await this.connect();
      const BULK_SIZE = 1000;
      let deletedCount = 0;
      
      for (let i = 0; i < idsToDelete.length; i += BULK_SIZE) {
        const batch = idsToDelete.slice(i, i + BULK_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        const query = `DELETE FROM \`${tableName}\` WHERE \`${pkColumn}\` IN (${placeholders})`;
        
        try {
          const [result] = await pool.query<any>(query, batch);
          deletedCount += result.affectedRows || 0;
        } catch (error) {
          const err = error as Error;
          logger.error(`Error deleting orphans in ${tableName}: ${err.message}`);
          throw err;
        }
      }
      
      return deletedCount;
    }, `MySQL:deleteBatch(${tableName})`);
  }

  async insertBatch(tableName: string, rows: Record<string, unknown>[]): Promise<number> {
    return withRetry(async () => {
    if (!rows || rows.length === 0) return 0;
    
    const pool = await this.connect();
    const columns = Object.keys(rows[0]);
    const columnNames = columns.map(c => `\`${c}\``).join(', ');
    
    // Bulk insert in sub-batches
    const BULK_SIZE = this.bulkSize;
    let inserted = 0;
    
    for (let i = 0; i < rows.length; i += BULK_SIZE) {
      const batch = rows.slice(i, i + BULK_SIZE);
      
      try {
        const placeholders = batch.map(() => 
          `(${columns.map(() => '?').join(', ')})`
        ).join(', ');
        
        const values = batch.flatMap(row => 
          columns.map(col => {
            const val = row[col];
            if (val === null || val === undefined) return null;
            // Handle Date objects
            if (val instanceof Date) {
              if (isNaN(val.getTime())) return null;
              return formatDateForMySQL(val);
            }
            if (typeof val === 'object') return JSON.stringify(val);
            return val;
          })
        );
        
        const sql = `INSERT IGNORE INTO \`${tableName}\` (${columnNames}) VALUES ${placeholders}`;
        await pool.query(sql, values);
        inserted += batch.length;
      } catch (error) {
        const err = error as Error;
        logger.warn(`Bulk insert fallback in ${tableName}: ${err.message.substring(0, 100)}`);
        // Fallback to row-by-row on error
        for (const row of batch) {
          try {
            const vals = columns.map(col => {
              const val = row[col];
              if (val === null || val === undefined) return null;
              // Handle Date objects
              if (val instanceof Date) {
                if (isNaN(val.getTime())) return null;
                return formatDateForMySQL(val);
              }
              if (typeof val === 'object') return JSON.stringify(val);
              return val;
            });
            await pool.query(`INSERT IGNORE INTO \`${tableName}\` (${columnNames}) VALUES (${columns.map(() => '?').join(', ')})`, vals);
            inserted++;
          } catch (e) {
            const insertErr = e as Error;
            logger.warn(`Insert skip in ${tableName}: ${insertErr.message.substring(0, 80)}`);
          }
        }
      }
    }
    
    return inserted;
    }, `MySQL:insertBatch(${tableName})`);
  }

  async upsertBatch(tableName: string, rows: Record<string, unknown>[], keyColumns: string[], _trackSync: boolean = false): Promise<number> {
    return withRetry(async () => {
    if (!rows || rows.length === 0) return 0;
    
    const pool = await this.connect();
    const columns = Object.keys(rows[0]);
    const columnNames = columns.map(c => `\`${c}\``).join(', ');
    
    const updateCols = columns
      .filter(c => !keyColumns.includes(c))
      .map(c => `\`${c}\` = VALUES(\`${c}\`)`)
      .join(', ');
    
    // Bulk upsert in sub-batches
    const BULK_SIZE = this.bulkSize;
    let upserted = 0;
    
    for (let i = 0; i < rows.length; i += BULK_SIZE) {
      const batch = rows.slice(i, i + BULK_SIZE);
      
      try {
        const placeholders = batch.map(() => 
          `(${columns.map(() => '?').join(', ')})`
        ).join(', ');
        
        const values = batch.flatMap(row => {
          return columns.map(col => {
            const val = row[col];
            if (val === null || val === undefined) return null;
            if (val instanceof Date) {
              if (isNaN(val.getTime())) return null;
              return formatDateForMySQL(val);
            }
            if (typeof val === 'object') return JSON.stringify(val);
            return val;
          });
        });
        
        const sql = `INSERT INTO \`${tableName}\` (${columnNames}) VALUES ${placeholders}
          ON DUPLICATE KEY UPDATE ${updateCols || columnNames.split(', ')[0] + '=' + columnNames.split(', ')[0]}`;
        await pool.query(sql, values);
        upserted += batch.length;
      } catch (error) {
        const err = error as Error & { code?: string };
        logger.error(`Bulk upsert error in ${tableName}: ${err.message}`);
        
        // Prevent fallback spam if the connection/pool itself is dead
        if (err.message.includes('Pool is closed') || err.code === 'ECONNRESET' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ER_LOCK_WAIT_TIMEOUT') {
          throw err;
        }

        // Fallback to row-by-row on error
        for (const row of batch) {
          try {
            const vals = columns.map(col => {
              const val = row[col];
              if (val === null || val === undefined) return null;
              if (val instanceof Date) {
                if (isNaN(val.getTime())) return null;
                return formatDateForMySQL(val);
              }
              if (typeof val === 'object') return JSON.stringify(val);
              return val;
            });
            const singleSql = `INSERT INTO \`${tableName}\` (${columnNames}) VALUES (${columns.map(() => '?').join(', ')})
              ON DUPLICATE KEY UPDATE ${updateCols || columnNames.split(', ')[0] + '=' + columnNames.split(', ')[0]}`;
            await pool.query(singleSql, vals);
            upserted++;
          } catch (e) {
            const upsertErr = e as Error;
            const keyVals = keyColumns.map(k => `${k}=${row[k]}`).join(',');
            logger.error(`Upsert error in ${tableName} [${keyVals}]: ${upsertErr.message}`);
          }
        }
      }
    }
    
    return upserted;
    }, `MySQL:upsertBatch(${tableName})`);
  }

  // Deprecated: _last_sync removed to prevent full table scans and MySQL freezes
  async deleteOrphanRows(_tableName: string, _syncStartTime: string): Promise<number> {
    return 0;
  }

  /**
   * Begin a bulk session: disable unique checks and foreign key checks
   * to reduce lock contention during heavy writes.
   * These are SESSION-level settings — only affect this connection.
   */
  async beginBulkSession(): Promise<void> {
    const pool = await this.connect();
    await pool.query('SET NAMES utf8mb4');
    await pool.query('SET CHARACTER SET utf8mb4');
    await pool.query('SET SESSION unique_checks = 0');
    await pool.query('SET SESSION foreign_key_checks = 0');
    await pool.query('SET SESSION innodb_lock_wait_timeout = 5');
  }

  /**
   * End a bulk session: re-enable unique checks and foreign key checks.
   */
  async endBulkSession(): Promise<void> {
    const pool = await this.connect();
    await pool.query('SET SESSION unique_checks = 1');
    await pool.query('SET SESSION foreign_key_checks = 1');
    await pool.query('SET SESSION innodb_lock_wait_timeout = 50');
  }

  async truncateTable(tableName: string): Promise<void> {
    const pool = await this.connect();
    // Use DELETE instead of TRUNCATE to avoid exclusive table lock
    await pool.query(`DELETE FROM \`${tableName}\``);
    logger.info(`Cleared table: ${tableName}`);
  }

  async countRows(tableName: string): Promise<number> {
    const pool = await this.connect();
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) as count FROM \`${tableName}\``);
    return rows[0].count;
  }

  async countRowsWithPrefix(tableName: string, column: string, prefixStart: string, prefixEnd?: string): Promise<number> {
    const pool = await this.connect();
    if (prefixStart && prefixEnd && prefixStart !== prefixEnd) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) as count FROM \`${tableName}\` WHERE CAST(\`${column}\` AS CHAR) >= ? AND CAST(\`${column}\` AS CHAR) < ?`,
        [prefixStart, prefixEnd + 'z']
      );
      return rows[0].count;
    } else {
      const prefix = prefixStart || prefixEnd;
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) as count FROM \`${tableName}\` WHERE CAST(\`${column}\` AS CHAR) LIKE ?`,
        [prefix + '%']
      );
      return rows[0].count;
    }
  }

  // Count rows where column value BETWEEN two actual values (for AN running numbers)
  async countRowsBetween(tableName: string, column: string, from: string, to: string): Promise<number> {
    const pool = await this.connect();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM \`${tableName}\` WHERE CAST(\`${column}\` AS CHAR) >= ? AND CAST(\`${column}\` AS CHAR) <= ?`,
      [from, to]
    );
    return rows[0].count;
  }

  async close(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      logger.info('MySQL connection closed');
    }
  }
}

export default new MySQLConnector();
