import { Pool, PoolClient, QueryResult } from 'pg';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { withRetry } from '../utils/retry';
import { PostgresConfig, TableColumn, DatabaseConfig, PgTableChangeStat } from '../types';

class PostgresConnector {
  private pool: Pool | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Sanitize identifier (table/column name) to prevent SQL injection
  private sanitizeIdentifier(name: string): string {
    // Only allow alphanumeric, underscore, and dot (for schema.table)
    if (!/^[a-zA-Z0-9_.]+$/.test(name)) {
      throw new Error(`Invalid identifier: ${name}`);
    }
    return `"${name}"`;
  }
  private config: PostgresConfig | null = null;

  async connect(customConfig: PostgresConfig | null = null): Promise<Pool> {
    if (this.pool && !customConfig) return this.pool;
    
    const config = customConfig || this.loadConfig();
    this.config = config;
    
    this.pool = new Pool({
      ...config,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    // Auto-recover on pool errors (don't crash the process)
    this.pool.on('error', (err) => {
      logger.error('PostgreSQL pool error (will auto-recover)', { error: err.message });
    });
    
    // Test connection and set read-only mode
    try {
      const client: PoolClient = await this.pool.connect();
      await client.query('SELECT 1');
      // Set read-only mode to protect source database
      await client.query('SET default_transaction_read_only = on');
      client.release();
      logger.info('PostgreSQL connected successfully (READ-ONLY mode)');
      
      // Start periodic health check (every 5 minutes)
      this.startHealthCheck();
      
      return this.pool;
    } catch (error) {
      const err = error as Error;
      logger.error('PostgreSQL connection failed', { error: err.message });
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
          const client = await this.pool.connect();
          await client.query('SELECT 1');
          client.release();
        }
      } catch (error) {
        const err = error as Error;
        logger.warn(`[HEALTH] PostgreSQL health check failed: ${err.message}, attempting reconnect...`);
        try {
          await this.close();
          await this.connect();
          logger.info('[HEALTH] PostgreSQL reconnected successfully');
        } catch (reconnectErr) {
          logger.error('[HEALTH] PostgreSQL reconnect failed', { error: (reconnectErr as Error).message });
        }
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  private loadConfig(): PostgresConfig {
    return {
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432'),
      database: process.env.PG_DATABASE || 'hospital_db',
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD || '',
    };
  }

  async reconnect(config: PostgresConfig): Promise<Pool> {
    await this.close();
    this.config = config;
    return this.connect(config);
  }

  async getTables(): Promise<string[]> {
    return withRetry(async () => {
      const pool = await this.connect();
      const result: QueryResult = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      return result.rows.map((row: { table_name: string }) => row.table_name);
    }, 'PG:getTables');
  }

  async getTableColumns(tableName: string): Promise<TableColumn[]> {
    return withRetry(async () => {
      const pool = await this.connect();
      const result: QueryResult = await pool.query(`
        SELECT 
          column_name,
          data_type,
          is_nullable,
          column_default,
          character_maximum_length,
          numeric_precision,
          numeric_scale
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);
      return result.rows as TableColumn[];
    }, `PG:getTableColumns(${tableName})`);
  }

  async getPrimaryKey(tableName: string): Promise<string[]> {
    const pool = await this.connect();
    
    // First try primary key
    const result: QueryResult = await pool.query(`
      SELECT a.attname as column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
    `, [tableName]);
    
    if (result.rows.length > 0) {
      return result.rows.map((row: { column_name: string }) => row.column_name);
    }
    
    // Fallback: check for unique indexes (pick the first one found)
    const uniqueResult: QueryResult = await pool.query(`
      SELECT a.attname as column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisunique AND NOT i.indisprimary
      ORDER BY i.indexrelid
      LIMIT 10
    `, [tableName]);
    
    return uniqueResult.rows.map((row: { column_name: string }) => row.column_name);
  }

  async fetchData(tableName: string, limit: number = 1000, offset: number = 0): Promise<Record<string, unknown>[]> {
    return withRetry(async () => {
      const pool = await this.connect();
      const safeTable = this.sanitizeIdentifier(tableName);
      const result: QueryResult = await pool.query(
        `SELECT * FROM ${safeTable} LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return result.rows;
    }, `PG:fetchData(${tableName})`);
  }

  async fetchIncremental(tableName: string, column: string, since: string): Promise<Record<string, unknown>[]> {
    const pool = await this.connect();
    const safeTable = this.sanitizeIdentifier(tableName);
    const safeColumn = this.sanitizeIdentifier(column);
    const result: QueryResult = await pool.query(
      `SELECT * FROM ${safeTable} WHERE ${safeColumn} >= $1 ORDER BY ${safeColumn}`,
      [since]
    );
    return result.rows;
  }

  async countRows(tableName: string): Promise<number> {
    return withRetry(async () => {
      const pool = await this.connect();
      const safeTable = this.sanitizeIdentifier(tableName);
      const result: QueryResult = await pool.query(`SELECT COUNT(*) as count FROM ${safeTable}`);
      return parseInt(result.rows[0].count);
    }, `PG:countRows(${tableName})`);
  }

  async countRowsWithPrefix(tableName: string, column: string, prefixStart: string, prefixEnd?: string): Promise<number> {
    const pool = await this.connect();
    const safeTable = this.sanitizeIdentifier(tableName);
    const safeColumn = this.sanitizeIdentifier(column);
    // Cast column to text and use LIKE for prefix matching
    let query: string;
    if (prefixStart && prefixEnd && prefixStart !== prefixEnd) {
      // Range of prefixes
      query = `SELECT COUNT(*) as count FROM ${safeTable} WHERE CAST(${safeColumn} AS TEXT) >= $1 AND CAST(${safeColumn} AS TEXT) < $2`;
      const result: QueryResult = await pool.query(query, [prefixStart, prefixEnd + 'z']);
      return parseInt(result.rows[0].count);
    } else {
      // Single prefix - use LIKE
      const prefix = prefixStart || prefixEnd;
      query = `SELECT COUNT(*) as count FROM ${safeTable} WHERE CAST(${safeColumn} AS TEXT) LIKE $1`;
      const result: QueryResult = await pool.query(query, [prefix + '%']);
      return parseInt(result.rows[0].count);
    }
  }

  // Count rows where column value BETWEEN two actual values (for AN running numbers)
  async countRowsBetween(tableName: string, column: string, from: string, to: string): Promise<number> {
    const pool = await this.connect();
    const safeTable = this.sanitizeIdentifier(tableName);
    const safeColumn = this.sanitizeIdentifier(column);
    const query = `SELECT COUNT(*) as count FROM ${safeTable} WHERE CAST(${safeColumn} AS TEXT) >= $1 AND CAST(${safeColumn} AS TEXT) <= $2`;
    const result: QueryResult = await pool.query(query, [from, to]);
    return parseInt(result.rows[0].count);
  }

  // Fetch all primary keys for orphan comparison
  async getPrimaryKeys(tableName: string, pkColumn: string, condition?: string, params?: any[]): Promise<Set<string>> {
    const pool = await this.connect();
    const safeTable = this.sanitizeIdentifier(tableName);
    const safeColumn = this.sanitizeIdentifier(pkColumn);
    
    let query = `SELECT ${safeColumn} as id FROM ${safeTable}`;
    if (condition) {
      query += ` WHERE ${condition}`;
    }
    
    const result: QueryResult = await pool.query(query, params || []);
    const idSet = new Set<string>();
    
    // Convert all IDs to string to ensure consistent comparison across DBs
    for (const row of result.rows) {
      if (row.id !== null && row.id !== undefined) {
        idSet.add(String(row.id));
      }
    }
    
    return idSet;
  }

  async fetchDataWithPrefix(
    tableName: string, 
    column: string, 
    prefixStart: string, 
    prefixEnd: string | undefined, 
    limit: number = 1000, 
    offset: number = 0
  ): Promise<Record<string, unknown>[]> {
    const pool = await this.connect();
    const safeTable = this.sanitizeIdentifier(tableName);
    const safeColumn = this.sanitizeIdentifier(column);
    let query: string;
    if (prefixStart && prefixEnd && prefixStart !== prefixEnd) {
      // Range of prefixes
      query = `SELECT * FROM ${safeTable} WHERE CAST(${safeColumn} AS TEXT) >= $1 AND CAST(${safeColumn} AS TEXT) < $2 LIMIT $3 OFFSET $4`;
      const result: QueryResult = await pool.query(query, [prefixStart, prefixEnd + 'z', limit, offset]);
      return result.rows;
    } else {
      // Single prefix - use LIKE
      const prefix = prefixStart || prefixEnd;
      query = `SELECT * FROM ${safeTable} WHERE CAST(${safeColumn} AS TEXT) LIKE $1 LIMIT $2 OFFSET $3`;
      const result: QueryResult = await pool.query(query, [prefix + '%', limit, offset]);
      return result.rows;
    }
  }

  // IPD: Find minimum AN where dchdate >= given date
  async getMinAnByDischargeDate(tableName: string, daysBack: number): Promise<string | null> {
    const pool = await this.connect();
    const safeTable = this.sanitizeIdentifier(tableName);
    // Check if table has 'dchdate' column
    const columns = await this.getTableColumns(tableName);
    const hasDchdate = columns.some(c => c.column_name.toLowerCase() === 'dchdate');
    
    if (!hasDchdate) {
      return null;
    }
    
    try {
      const safeDaysBack = parseInt(String(daysBack));
      const query = `
        SELECT MIN(an) as min_an 
        FROM ${safeTable} 
        WHERE dchdate >= CURRENT_DATE - INTERVAL '${safeDaysBack} days'
      `;
      const result: QueryResult = await pool.query(query);
      return result.rows[0]?.min_an || null;
    } catch (error) {
      const err = error as Error;
      logger.error(`Failed to get min AN from ${tableName}`, { error: err.message });
      return null;
    }
  }

  // IPD: Count rows where AN >= minAn
  async countRowsByAnRange(tableName: string, minAn: string): Promise<number> {
    const pool = await this.connect();
    const safeTable = this.sanitizeIdentifier(tableName);
    const query = `SELECT COUNT(*) as count FROM ${safeTable} WHERE CAST(an AS TEXT) >= $1`;
    const result: QueryResult = await pool.query(query, [minAn]);
    return parseInt(result.rows[0].count);
  }

  // IPD: Fetch rows where AN >= minAn
  async fetchDataByAnRange(
    tableName: string,
    minAn: string,
    limit: number = 1000,
    offset: number = 0
  ): Promise<Record<string, unknown>[]> {
    const pool = await this.connect();
    const safeTable = this.sanitizeIdentifier(tableName);
    const query = `SELECT * FROM ${safeTable} WHERE CAST(an AS TEXT) >= $1 ORDER BY an LIMIT $2 OFFSET $3`;
    const result: QueryResult = await pool.query(query, [minAn, limit, offset]);
    return result.rows;
  }

  // IPD: Get minimum AN from an_stat table based on dchdate
  async getMinAnFromAnStat(daysBack: number): Promise<string | null> {
    const pool = await this.connect();
    
    try {
      const safeDaysBack = parseInt(String(daysBack));
      const query = `
        SELECT MIN(an) as min_an 
        FROM "an_stat" 
        WHERE dchdate >= CURRENT_DATE - INTERVAL '${safeDaysBack} days'
      `;
      const result: QueryResult = await pool.query(query);
      const minAn = result.rows[0]?.min_an;
      if (minAn) {
        logger.info(`Found min AN from an_stat: ${minAn} (dchdate >= ${daysBack} days ago)`);
      }
      return minAn || null;
    } catch (error) {
      const err = error as Error;
      logger.error(`Failed to get min AN from an_stat`, { error: err.message });
      return null;
    }
  }

  // IPD: Get min/max AN from an_stat by dchdate range (for integrity check)
  async getAnRangeByDchdate(dateFrom: string, dateTo: string): Promise<{ minAn: string | null; maxAn: string | null }> {
    const pool = await this.connect();
    try {
      const query = `
        SELECT MIN(an) as min_an, MAX(an) as max_an 
        FROM "an_stat" 
        WHERE dchdate >= $1 AND dchdate <= $2
      `;
      const result: QueryResult = await pool.query(query, [dateFrom, dateTo]);
      return {
        minAn: result.rows[0]?.min_an || null,
        maxAn: result.rows[0]?.max_an || null,
      };
    } catch (error) {
      const err = error as Error;
      logger.error(`Failed to get AN range from an_stat`, { error: err.message });
      return { minAn: null, maxAn: null };
    }
  }

  // Get table modification statistics from pg_stat_user_tables & pg_statio_user_tables (Read-Only)
  async getTableChangeStats(tableNames?: string[]): Promise<PgTableChangeStat[]> {
    return withRetry(async () => {
      const pool = await this.connect();
      let query = `
        SELECT 
          s.relname AS table_name,
          COALESCE(s.n_tup_ins, 0)::bigint AS inserted_count,
          COALESCE(s.n_tup_upd, 0)::bigint AS updated_count,
          COALESCE(s.n_tup_del, 0)::bigint AS deleted_count,
          (COALESCE(s.n_tup_ins, 0) + COALESCE(s.n_tup_upd, 0) + COALESCE(s.n_tup_del, 0))::bigint AS tup_changes,
          (
            COALESCE(s.seq_scan, 0) + 
            COALESCE(s.idx_scan, 0) + 
            COALESCE(s.idx_tup_fetch, 0) + 
            COALESCE(io.heap_blks_read, 0) + 
            COALESCE(io.heap_blks_hit, 0) + 
            COALESCE(c.reltuples, 0)
          )::bigint AS total_score
        FROM pg_stat_user_tables s
        LEFT JOIN pg_statio_user_tables io ON s.schemaname = io.schemaname AND s.relname = io.relname
        LEFT JOIN pg_class c ON c.relname = s.relname AND c.relkind = 'r'
      `;
      const params: any[] = [];
      if (tableNames && tableNames.length > 0) {
        query += ` WHERE s.relname = ANY($1)`;
        params.push(tableNames);
      }
      query += ` ORDER BY s.relname`;

      const result: QueryResult = await pool.query(query, params);
      return result.rows.map((row) => {
        const tupChanges = Number(row.tup_changes);
        const totalScore = Number(row.total_score);
        
        // If tuple counters (n_tup_ins/upd/del) are active (> 0, e.g. on Master DB), use tupChanges.
        // Otherwise (on Slave DB where tuple stats are 0), use totalScore (scan + I/O + reltuples).
        const totalChanges = tupChanges > 0 ? tupChanges : totalScore;

        return {
          tableName: row.table_name,
          insertedCount: Number(row.inserted_count),
          updatedCount: Number(row.updated_count),
          deletedCount: Number(row.deleted_count),
          totalChanges,
        };
      });
    }, 'PG:getTableChangeStats');
  }

  async close(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      logger.info('PostgreSQL connection closed');
    }
  }
}

export default new PostgresConnector();
