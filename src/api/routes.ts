import express, { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import tableClassifier from '../classifiers/tableClassifier';
import transferEngine from '../transfer/transferEngine';
import transferHistory from '../transfer/transferHistory';
import jobScheduler from '../scheduler/jobScheduler';
import logger from '../utils/logger';
import pgChangeDetector from '../utils/pgChangeDetector';
import postgresConnector from '../connectors/postgres';
import mysqlConnector from '../connectors/mysql';
import aiDiagnoser from '../ai/aiDiagnoser';
import schemaTranslator from '../ai/schemaTranslator';
import { loadTelegramConfig, saveTelegramConfig, sendTelegramMessage, TelegramConfig } from '../utils/telegram';
import {
  DatabaseConfig,
  PostgresConfig,
  MySQLConfig,
  TransferType,
  CheckCountsRequest,
  CheckCountsResult,
  TestConnectionRequest,
  TransferOptions
} from '../types';

const router: Router = express.Router();

// Database config file path
const configPath = path.join(process.cwd(), 'config/database.json');

// Load database config
function loadDbConfig(): DatabaseConfig {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as DatabaseConfig;
    }
  } catch (error) {
    const err = error as Error;
    logger.error('Error loading database config', { error: err.message });
  }
  return {
    postgres: {
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432'),
      database: process.env.PG_DATABASE || 'hospital_db',
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD || '',
    },
    mysql: {
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      database: process.env.MYSQL_DATABASE || 'hospital_db',
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
    }
  };
}

// Save database config
function saveDbConfig(config: DatabaseConfig): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Get database config
router.get('/config/database', (_req: Request, res: Response) => {
  const config = loadDbConfig();
  // Return actual config for display (passwords included)
  res.json(config);
});

// Save database config
router.post('/config/database', async (req: Request, res: Response) => {
  try {
    const { postgres, mysql: mysqlConfig } = req.body as { postgres: PostgresConfig; mysql: MySQLConfig };
    
    // Save directly (no masking needed anymore)
    const newConfig: DatabaseConfig = {
      postgres: {
        host: postgres.host,
        port: parseInt(String(postgres.port)) || 5432,
        database: postgres.database,
        user: postgres.user,
        password: postgres.password || '',
      },
      mysql: {
        host: mysqlConfig.host,
        port: parseInt(String(mysqlConfig.port)) || 3306,
        database: mysqlConfig.database,
        user: mysqlConfig.user,
        password: mysqlConfig.password || '',
      }
    };
    
    saveDbConfig(newConfig);
    
    // Reconnect with new config
    await postgresConnector.reconnect(newConfig.postgres);
    await mysqlConnector.reconnect(newConfig.mysql);
    
    // Clear table cache
    tableClassifier.clearCache();
    
    logger.info('Database configuration updated');
    res.json({ success: true, message: 'Configuration saved' });
  } catch (error) {
    const err = error as Error;
    logger.error('Error saving config', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Test database connection
router.post('/config/test', async (req: Request, res: Response) => {
  try {
    const { type, config } = req.body as TestConnectionRequest;
    
    if (type === 'postgres') {
      const pool = new Pool(config as PostgresConfig);
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      await pool.end();
      res.json({ success: true, message: 'PostgreSQL connected successfully' });
    } else if (type === 'mysql') {
      const connection = await mysql.createConnection(config as MySQLConfig);
      await connection.query('SELECT 1');
      await connection.end();
      res.json({ success: true, message: 'MySQL connected successfully' });
    } else {
      res.status(400).json({ error: 'Invalid database type' });
    }
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// ==================== Telegram Config ====================

// Get telegram config
router.get('/config/telegram', (_req: Request, res: Response) => {
  const config = loadTelegramConfig();
  res.json(config);
});

// Save telegram config
router.post('/config/telegram', (req: Request, res: Response) => {
  try {
    const config = req.body as TelegramConfig;
    saveTelegramConfig(config);
    logger.info('Telegram configuration updated');
    res.json({ success: true, message: 'Configuration saved' });
  } catch (error) {
    const err = error as Error;
    logger.error('Error saving telegram config', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Test telegram connection
router.post('/config/telegram/test', async (req: Request, res: Response) => {
  try {
    const { botToken, chatId } = req.body as { botToken: string; chatId: string };
    
    if (!botToken || !chatId) {
      return res.status(400).json({ error: 'Bot Token and Chat ID are required' });
    }
    
    // Test with temporary config
    const testConfig: TelegramConfig = {
      enabled: true,
      botToken,
      chatId
    };
    
    const message = "✅ <b>ทดสอบการเชื่อมต่อ Telegram Bot</b>\n\nการแจ้งเตือนจากระบบ Data Transfer PostgreSQL -> MySQL ทำงานปกติ";
    const success = await sendTelegramMessage(message, testConfig);
    
    if (success) {
      res.json({ success: true, message: 'Telegram test message sent successfully' });
    } else {
      res.status(500).json({ error: 'Failed to send Telegram message. Please check token and chat ID.' });
    }
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// ==================== Tables ====================

// Get all tables classified
router.get('/tables', async (_req: Request, res: Response) => {
  try {
    const summary = await tableClassifier.getSummary();
    res.json(summary);
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /tables', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get detailed classification
router.get('/tables/classified', async (req: Request, res: Response) => {
  try {
    const includeRowCounts = req.query.counts === 'true';
    const classified = await tableClassifier.classify(includeRowCounts);
    res.json(classified);
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /tables/classified', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Check table counts with VN/AN filter
router.post('/tables/check-counts', async (req: Request, res: Response) => {
  try {
    const { type, vnStart, vnEnd, anStart, anEnd, tableNames, workerId } = req.body as CheckCountsRequest;
    const classified = await tableClassifier.classify();
    
    // Reset worker status to clear old transfer statuses
    if (workerId) {
      transferEngine.resetWorkerStatus(workerId);
    }
    
    let tablesData = type === 'basic' ? classified.basic :
                     type === 'opd' ? classified.opd :
                     type === 'ipd' ? classified.ipd : [];
    
    // Filter by tableNames if specified (for batch checking)
    if (tableNames && Array.isArray(tableNames) && tableNames.length > 0) {
      tablesData = tablesData.filter(t => tableNames.includes(t.name));
    }
    
    const results: CheckCountsResult[] = [];
    
    for (const table of tablesData) {
      let rowCount = 0;
      try {
        if (type === 'opd' && vnStart && table.hasVn) {
          // Count with VN prefix filter
          rowCount = await postgresConnector.countRowsWithPrefix(table.name, 'vn', vnStart, vnEnd);
        } else if (type === 'ipd' && anStart && table.hasAn) {
          // Count with AN prefix filter
          rowCount = await postgresConnector.countRowsWithPrefix(table.name, 'an', anStart, anEnd);
        } else {
          // Count all rows
          rowCount = await postgresConnector.countRows(table.name);
        }
      } catch (e) {
        const err = e as Error;
        logger.error(`Failed to count ${table.name}`, { error: err.message });
      }
      
      results.push({
        name: table.name,
        hasVn: table.hasVn,
        hasAn: table.hasAn,
        rowCount,
      });
    }
    
    logger.info(`Check counts: ${type}, tables=${results.length}`);
    res.json({ success: true, tables: results });
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /tables/check-counts', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Create all tables in MySQL - Now handled automatically during classification
router.post('/tables/create-all', (_req: Request, res: Response) => {
  res.json({ 
    success: true, 
    message: 'Tables are auto-created during classification',
    created: 0,
    skipped: 0,
    errors: []
  });
});

// Refresh table classification
router.post('/tables/refresh', async (_req: Request, res: Response) => {
  try {
    tableClassifier.clearCache();
    const summary = await tableClassifier.getSummary();
    res.json({ success: true, ...summary });
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /tables/refresh', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get raw table change statistics from pg_stat_user_tables
router.get('/tables/changes', async (req: Request, res: Response) => {
  try {
    const tableNames = req.query.tables ? String(req.query.tables).split(',') : undefined;
    const stats = await postgresConnector.getTableChangeStats(tableNames);
    res.json({ success: true, count: stats.length, stats });
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /tables/changes', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Compare table changes with snapshot to detect updated tables
router.post('/tables/check-changes', async (req: Request, res: Response) => {
  try {
    const { tableNames } = req.body as { tableNames?: string[] };
    const results = await pgChangeDetector.checkChanges(tableNames);
    const changedCount = results.filter(r => r.hasChanged).length;
    res.json({ success: true, total: results.length, changedCount, results });
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /tables/check-changes', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Start transfer with worker ID for multi-tab support
router.post('/transfer', async (req: Request, res: Response) => {
  try {
    const { type, tables, from, to, dryRun, workerId, smartSync } = req.body as {
      type: TransferType;
      tables?: string[];
      from?: string;
      to?: string;
      dryRun?: boolean;
      workerId?: string;
      smartSync?: boolean;
    };
    
    // Check if this worker is already running
    const status = transferEngine.getWorkerStatus(workerId || 'default');
    if (status && status.isRunning) {
      return res.status(400).json({ error: 'This worker is already running a transfer' });
    }

    const options: TransferOptions = { 
      dryRun: dryRun || false,
      tables: tables || null,
      from: from || null,
      to: to || null,
      workerId: workerId || 'default',
      smartSync: !!smartSync,
    };

    // Return immediately, transfer runs in background
    res.json({ success: true, message: 'Transfer started', type, workerId: options.workerId, smartSync: options.smartSync });

    // Execute transfer
    if (type === 'all') {
      await transferEngine.transferAll(options);
    } else {
      await transferEngine.transfer(type, options);
    }
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /transfer', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// Get all worker statuses
router.get('/transfer/status', (_req: Request, res: Response) => {
  try {
    const statuses = transferEngine.getAllStatuses();
    res.json(statuses);
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /transfer/status', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Start a transfer for a SINGLE table (repair mode)
router.post('/transfer/table', async (req: Request, res: Response) => {
  try {
    const { tableName, type, dryRun, dateFrom, dateTo } = req.body as {
      tableName: string;
      type: 'opd' | 'ipd' | 'basic';
      dryRun?: boolean;
      dateFrom?: string;
      dateTo?: string;
    };

    if (!tableName || !type) {
      return res.status(400).json({ error: 'tableName and type are required' });
    }

    const workerId = `repair_${tableName}_${Date.now()}`;

    // Helper to convert date if provided (matching original transfer logic)
    let fromPrefix: string | undefined;
    let toPrefix: string | undefined;

    if (type === 'opd') {
      if (dateFrom) fromPrefix = dateFrom.replace(/-/g, '').substring(2); // YYYYMMDD -> YYMMDD
      if (dateTo) toPrefix = dateTo.replace(/-/g, '').substring(2);
    }

    const startOptions: TransferOptions = {
      tables: [tableName], // The transferEngine maps this to specificTables internally
      dryRun: !!dryRun,
      source: 'manual',
      from: fromPrefix || dateFrom, // For OPD it expects YYMMDD prefix, for IPD it might expect AN range or ignore
      to: toPrefix || dateTo,
      workerId
    };

    logger.info(`Starting single table transfer: ${tableName} (${type})`);
    
    // Start asynchronously
    transferEngine.transfer(type, startOptions).catch((err: Error) => {
      logger.error(`Repair worker failed for ${tableName}:`, err);
    });

    res.json({ 
      success: true, 
      message: `Started transfer for table ${tableName}`,
      workerId
    });
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /transfer/table', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get specific worker status
router.get('/transfer/status/:workerId', (req: Request, res: Response) => {
  try {
    const status = transferEngine.getWorkerStatus(req.params.workerId);
    res.json(status || { isRunning: false });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// Get schedule status
router.get('/schedule', (_req: Request, res: Response) => {
  try {
    const status = jobScheduler.getStatus();
    res.json(status);
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /schedule', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Scheduler config file path
const schedulerConfigPath = path.join(process.cwd(), 'config/tables.json');

// Get scheduler config
router.get('/config/scheduler', (_req: Request, res: Response) => {
  try {
    if (fs.existsSync(schedulerConfigPath)) {
      const config = JSON.parse(fs.readFileSync(schedulerConfigPath, 'utf-8'));
      res.json(config);
    } else {
      // Return defaults
      res.json({
        basic: { schedule: '0 2 * * *', enabled: true, description: 'ข้อมูลพื้นฐาน' },
        opd: { schedule: '*/30 * * * *', enabled: true, description: 'ข้อมูล OPD', opdDaysBack: 7 },
        ipd: { schedule: '*/30 * * * *', enabled: true, description: 'ข้อมูล IPD', ipdDaysBack: 45 },
      });
    }
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// Save scheduler config
router.post('/config/scheduler', async (req: Request, res: Response) => {
  try {
    const reqConfig = req.body;
    
    // Load existing config to preserve table include/exclude patterns
    let existingConfig: Record<string, any> = {};
    try {
      if (fs.existsSync(schedulerConfigPath)) {
        existingConfig = JSON.parse(fs.readFileSync(schedulerConfigPath, 'utf-8'));
      }
    } catch (e) {
      // Use defaults if file doesn't exist
    }
    
    // Merge: update schedule/enabled/description but preserve existing tables config
    const newConfig = {
      basic: {
        schedule: reqConfig.basic.schedule,
        enabled: reqConfig.basic.enabled,
        description: reqConfig.basic.description,
        tables: existingConfig.basic?.tables || { include: ['*'], exclude: [] }
      },
      opd: {
        schedule: reqConfig.opd.schedule,
        enabled: reqConfig.opd.enabled,
        description: reqConfig.opd.description,
        opdDaysBack: reqConfig.opd.opdDaysBack || 7,
        tables: existingConfig.opd?.tables || { include: ['*'], exclude: [] }
      },
      ipd: {
        schedule: reqConfig.ipd.schedule,
        enabled: reqConfig.ipd.enabled,
        description: reqConfig.ipd.description,
        ipdDaysBack: reqConfig.ipd.ipdDaysBack || 45,
        tables: existingConfig.ipd?.tables || { include: ['*'], exclude: [] }
      }
    };
    
    // Save to file
    fs.writeFileSync(schedulerConfigPath, JSON.stringify(newConfig, null, 2));
    
    // Reload config and restart scheduler
    // Note: config module is already imported via jobScheduler, just reload fresh from disk
    jobScheduler.restart();
    
    logger.info('Scheduler configuration updated', { 
      basic: newConfig.basic.schedule,
      opd: newConfig.opd.schedule,
      ipd: newConfig.ipd.schedule
    });
    
    res.json({ success: true, message: 'Scheduler configuration saved' });
  } catch (error) {
    const err = error as Error;
    logger.error('Error saving scheduler config', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// Get logs
router.get('/logs', (_req: Request, res: Response) => {
  try {
    const logs = logger.getRecentLogs();
    res.json(logs);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// Health check
router.get('/health', async (_req: Request, res: Response) => {
  try {
    let pgStatus = 'unknown';
    let mysqlStatus = 'unknown';
    
    try {
      await postgresConnector.connect();
      pgStatus = 'connected';
    } catch (e) {
      const err = e as Error;
      pgStatus = 'error: ' + err.message;
    }
    
    try {
      await mysqlConnector.connect();
      mysqlStatus = 'connected';
    } catch (e) {
      const err = e as Error;
      mysqlStatus = 'error: ' + err.message;
    }
    
    res.json({
      status: 'ok',
      postgres: pgStatus,
      mysql: mysqlStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// ==================== Transfer History ====================

// Get transfer history
router.get('/history', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const result = transferHistory.getAll(limit, offset);
    res.json(result);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// Get transfer stats
router.get('/history/stats', (req: Request, res: Response) => {
  try {
    const stats = transferHistory.getStats();
    res.json(stats);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// Retry failed tables from a history record
router.post('/transfer/retry', async (req: Request, res: Response) => {
  try {
    const { historyId, workerId } = req.body;
    if (!historyId) {
      return res.status(400).json({ error: 'historyId is required' });
    }
    
    const record = transferHistory.getById(historyId);
    if (!record) {
      return res.status(404).json({ error: 'History record not found' });
    }
    
    const failedTables = record.errors.map(e => e.table);
    if (failedTables.length === 0) {
      return res.status(400).json({ error: 'No failed tables to retry' });
    }
    
    logger.info(`Retry transfer for failed tables`, { historyId, tables: failedTables });
    
    // Start transfer in background
    transferEngine.transfer(record.type, {
      tables: failedTables,
      workerId: workerId || 'retry-' + Date.now(),
    }).catch(err => {
      logger.error('Retry transfer failed', { error: err.message });
    });
    
    res.json({ success: true, tables: failedTables });
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// ==================== Data Integrity Check ====================

router.post('/integrity/check', async (req: Request, res: Response) => {
  try {
    const { type, dateFrom, dateTo } = req.body as {
      type: 'opd' | 'ipd' | 'basic' | 'all';
      dateFrom?: string; // YYYY-MM-DD
      dateTo?: string;   // YYYY-MM-DD
    };

    const classified = await tableClassifier.classify();

    // Helper: convert Gregorian date to Buddhist VN prefix (YYMMDD)
    function dateToVnPrefix(dateStr: string): string {
      const d = new Date(dateStr);
      const buddhistYear = (d.getFullYear() + 543) % 100;
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${buddhistYear.toString().padStart(2, '0')}${month}${day}`;
    }

    // Calculate VN prefix range from dates (only for OPD)
    let vnFrom: string | undefined;
    let vnTo: string | undefined;
    if (dateFrom) vnFrom = dateToVnPrefix(dateFrom);
    if (dateTo) vnTo = dateToVnPrefix(dateTo);

    // For IPD: get AN range from an_stat by dchdate (AN is running number, not date prefix)
    let anFrom: string | undefined;
    let anTo: string | undefined;
    if ((type === 'ipd' || type === 'all') && dateFrom && dateTo) {
      const anRange = await postgresConnector.getAnRangeByDchdate(dateFrom, dateTo);
      anFrom = anRange.minAn || undefined;
      anTo = anRange.maxAn || undefined;
    }

    // Determine which table sets to check  
    interface TableSet {
      name: string;
      tables: typeof classified.basic;
      filterCol?: string;
      from?: string;
      to?: string;
      filterLabel?: string;
      useRange?: boolean; // true = use BETWEEN (for AN), false = use prefix LIKE (for VN)
    }
    const tableSets: TableSet[] = [];
    
    if (type === 'basic' || type === 'all') {
      tableSets.push({ name: 'basic', tables: classified.basic });
    }
    if (type === 'opd' || type === 'all') {
      tableSets.push({
        name: 'opd',
        tables: classified.opd,
        filterCol: 'vn',
        from: vnFrom,
        to: vnTo,
        filterLabel: vnFrom && vnTo ? (vnFrom === vnTo ? `vn LIKE '${vnFrom}%'` : `vn ${vnFrom}~${vnTo}`) : undefined,
      });
    }
    if (type === 'ipd' || type === 'all') {
      tableSets.push({
        name: 'ipd',
        tables: classified.ipd,
        filterCol: 'an',
        from: anFrom,
        to: anTo,
        useRange: true, // AN is running number, use BETWEEN instead of LIKE
        filterLabel: anFrom && anTo ? `an ${anFrom}~${anTo}` : (anFrom ? `an >= ${anFrom}` : undefined),
      });
    }

    const results: {
      name: string;
      category: string;
      pgCount: number;
      mysqlCount: number;
      diff: number;
      isMatch: boolean;
      filterUsed: string;
    }[] = [];

    for (const set of tableSets) {
      for (const table of set.tables) {
        try {
          let pgCount = 0;
          let mysqlCount = 0;
          let filterUsed = 'ทั้งหมด';

          const hasFilterCol = (set.filterCol === 'vn' && table.hasVn) || (set.filterCol === 'an' && table.hasAn);

          if (hasFilterCol && set.from && set.to && set.useRange) {
            // IPD: use BETWEEN for AN running numbers
            pgCount = await postgresConnector.countRowsBetween(table.name, set.filterCol!, set.from, set.to);
            mysqlCount = await mysqlConnector.countRowsBetween(table.name, set.filterCol!, set.from, set.to);
            filterUsed = set.filterLabel || `${set.filterCol} BETWEEN ${set.from} AND ${set.to}`;
          } else if (hasFilterCol && set.from) {
            // OPD: use prefix LIKE for VN
            pgCount = await postgresConnector.countRowsWithPrefix(table.name, set.filterCol!, set.from, set.to);
            mysqlCount = await mysqlConnector.countRowsWithPrefix(table.name, set.filterCol!, set.from, set.to);
            filterUsed = set.filterLabel || `${set.filterCol} >= ${set.from}`;
          } else {
            pgCount = await postgresConnector.countRows(table.name);
            mysqlCount = await mysqlConnector.countRows(table.name);
          }

          const diff = pgCount - mysqlCount;
          results.push({
            name: table.name,
            category: set.name,
            pgCount,
            mysqlCount,
            diff,
            isMatch: Math.abs(diff) < 10,
            filterUsed,
          });
        } catch (err) {
          const e = err as Error;
          logger.error(`Integrity check error for ${table.name}: ${e.message}`);
          results.push({
            name: table.name,
            category: set.name,
            pgCount: -1,
            mysqlCount: -1,
            diff: 0,
            isMatch: false,
            filterUsed: `Error: ${e.message.substring(0, 50)}`,
          });
        }
      }
    }

    const matched = results.filter(r => r.isMatch).length;
    const mismatched = results.filter(r => !r.isMatch).length;

    res.json({
      success: true,
      tables: results,
      summary: { matched, mismatched, total: results.length },
      prefixInfo: { vnFrom, vnTo, anFrom, anTo },
    });
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /integrity/check', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/integrity/stream', async (req: Request, res: Response) => {
  // Setup SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // flush headers to establish SSE connection immediately

  try {
    const type = (req.query.type as string) || 'all';
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;

    const classified = await tableClassifier.classify();

    // Helper: convert Gregorian date to Buddhist VN prefix (YYMMDD)
    function dateToVnPrefix(dateStr: string): string {
      const d = new Date(dateStr);
      const buddhistYear = (d.getFullYear() + 543) % 100;
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${buddhistYear.toString().padStart(2, '0')}${month}${day}`;
    }

    // Calculate VN prefix range from dates (only for OPD)
    let vnFrom: string | undefined;
    let vnTo: string | undefined;
    if (dateFrom) vnFrom = dateToVnPrefix(dateFrom);
    if (dateTo) vnTo = dateToVnPrefix(dateTo);

    // For IPD: get AN range from an_stat by dchdate
    let anFrom: string | undefined;
    let anTo: string | undefined;
    if ((type === 'ipd' || type === 'all') && dateFrom && dateTo) {
      const anRange = await postgresConnector.getAnRangeByDchdate(dateFrom, dateTo);
      anFrom = anRange.minAn || undefined;
      anTo = anRange.maxAn || undefined;
    }

    // Determine which table sets to check  
    interface TableSet {
      name: string;
      tables: typeof classified.basic;
      filterCol?: string;
      from?: string;
      to?: string;
      filterLabel?: string;
      useRange?: boolean;
    }
    const tableSets: TableSet[] = [];
    
    if (type === 'basic' || type === 'all') {
      tableSets.push({ name: 'basic', tables: classified.basic });
    }
    if (type === 'opd' || type === 'all') {
      tableSets.push({
        name: 'opd',
        tables: classified.opd,
        filterCol: 'vn',
        from: vnFrom,
        to: vnTo,
        filterLabel: vnFrom && vnTo ? (vnFrom === vnTo ? `vn LIKE '${vnFrom}%'` : `vn ${vnFrom}~${vnTo}`) : undefined,
      });
    }
    if (type === 'ipd' || type === 'all') {
      tableSets.push({
        name: 'ipd',
        tables: classified.ipd,
        filterCol: 'an',
        from: anFrom,
        to: anTo,
        useRange: true,
        filterLabel: anFrom && anTo ? `an ${anFrom}~${anTo}` : (anFrom ? `an >= ${anFrom}` : undefined),
      });
    }

    const totalTables = tableSets.reduce((sum, set) => sum + set.tables.length, 0);
    
    // Send init event
    res.write(`data: ${JSON.stringify({ action: 'init', totalTables, prefixInfo: { vnFrom, vnTo, anFrom, anTo } })}\n\n`);

    let matched = 0;
    let mismatched = 0;
    let checkedCount = 0;

    for (const set of tableSets) {
      for (const table of set.tables) {
        checkedCount++;
        let resultData: any;
        
        try {
          let pgCount = 0;
          let mysqlCount = 0;
          let filterUsed = 'ทั้งหมด';

          const hasFilterCol = (set.filterCol === 'vn' && table.hasVn) || (set.filterCol === 'an' && table.hasAn);

          if (hasFilterCol && set.from && set.to && set.useRange) {
            pgCount = await postgresConnector.countRowsBetween(table.name, set.filterCol!, set.from, set.to);
            mysqlCount = await mysqlConnector.countRowsBetween(table.name, set.filterCol!, set.from, set.to);
            filterUsed = set.filterLabel || `${set.filterCol} BETWEEN ${set.from} AND ${set.to}`;
          } else if (hasFilterCol && set.from) {
            pgCount = await postgresConnector.countRowsWithPrefix(table.name, set.filterCol!, set.from, set.to);
            mysqlCount = await mysqlConnector.countRowsWithPrefix(table.name, set.filterCol!, set.from, set.to);
            filterUsed = set.filterLabel || `${set.filterCol} >= ${set.from}`;
          } else {
            pgCount = await postgresConnector.countRows(table.name);
            mysqlCount = await mysqlConnector.countRows(table.name);
          }

          const diff = pgCount - mysqlCount;
          const isMatch = Math.abs(diff) < 10;
          
          if (isMatch) matched++;
          else mismatched++;

          resultData = {
            name: table.name,
            category: set.name,
            pgCount,
            mysqlCount,
            diff,
            isMatch,
            filterUsed,
          };
        } catch (err) {
          const e = err as Error;
          logger.error(`Integrity stream error for ${table.name}: ${e.message}`);
          mismatched++;
          resultData = {
            name: table.name,
            category: set.name,
            pgCount: -1,
            mysqlCount: -1,
            diff: 0,
            isMatch: false,
            filterUsed: `Error: ${e.message.substring(0, 50)}`,
          };
        }
        
        // Send table result
        res.write(`data: ${JSON.stringify({ action: 'table', checkedCount, totalTables, table: resultData })}\n\n`);
      }
    }

    // Send completion event
    res.write(`data: ${JSON.stringify({ action: 'complete', summary: { matched, mismatched, total: totalTables } })}\n\n`);
    res.end();
  } catch (error) {
    const err = error as Error;
    logger.error('API error: /integrity/stream', { error: err.message });
    res.write(`data: ${JSON.stringify({ action: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

// AI Diagnostics & Schema Translation Endpoints
router.get('/ai/status', (req: Request, res: Response) => {
  res.json({
    provider: aiDiagnoser.getProvider(),
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
  });
});

router.post('/ai/diagnose', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { errorMessage, tableName, contextData } = req.body;
    if (!errorMessage) {
      return res.status(400).json({ error: 'errorMessage is required' });
    }
    const diagnosis = await aiDiagnoser.diagnoseError(errorMessage, tableName, contextData);
    res.json(diagnosis);
  } catch (error) {
    next(error);
  }
});

router.post('/ai/schema-translate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tableName } = req.body;
    if (!tableName) {
      return res.status(400).json({ error: 'tableName is required' });
    }
    const columns = await postgresConnector.getTableColumns(tableName);
    const primaryKeys = await postgresConnector.getPrimaryKey(tableName);
    const translation = schemaTranslator.translateSchema(tableName, columns, primaryKeys);
    res.json(translation);
  } catch (error) {
    next(error);
  }
});

router.post('/tools/drop-last-sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await mysqlConnector.dropLastSyncFromAllTables();
    res.json({
      success: true,
      message: `Dropped _last_sync column from ${result.droppedCount} tables.`,
      result
    });
  } catch (error) {
    next(error);
  }
});

export default router;
