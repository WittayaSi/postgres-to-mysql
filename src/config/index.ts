import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { PostgresConfig, MySQLConfig, TablesConfig, TableTypeConfig } from '../types';

dotenv.config();

export interface AppConfig {
  postgres: PostgresConfig;
  mysql: MySQLConfig;
  server: { port: number };
  transfer: {
    batchSize: number;
    throttleMs: number;
  };
  getTablesConfig: () => TablesConfig;
}

const defaultTableConfig: TableTypeConfig = {
  schedule: '0 2 * * *',
  enabled: true,
  tables: { include: ['*'], exclude: [] }
};

const config = {
  // PostgreSQL Configuration
  postgres: {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'hospital_db',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
  } as PostgresConfig,
  
  // MySQL Configuration
  mysql: {
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    database: process.env.MYSQL_DATABASE || 'hospital_db',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
  } as MySQLConfig,
  
  // Server Configuration
  server: {
    port: parseInt(process.env.PORT || '3030'),
  },
  
  // Transfer Configuration
  transfer: {
    batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
    throttleMs: parseInt(process.env.MYSQL_THROTTLE_MS || '50'),
  },
  
  // Load tables configuration (always reads fresh from disk)
  getTablesConfig(): TablesConfig {
    try {
      const configPath = path.join(process.cwd(), 'config/tables.json');
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content) as TablesConfig;
      }
    } catch (error) {
      // Fallback to default
    }
    return {
      basic: { ...defaultTableConfig, schedule: '0 2 * * *' },
      opd: { ...defaultTableConfig, schedule: '*/30 * * * *' },
      ipd: { ...defaultTableConfig, schedule: '*/30 * * * *' },
    };
  },
  
  // Hot reload config - just for logging, getTablesConfig always reads fresh
  reload(): void {
    const tables = this.getTablesConfig();
    console.log('[CONFIG] Reloaded tables config:', {
      basic: tables.basic.schedule,
      opd: tables.opd.schedule,
      ipd: tables.ipd.schedule,
    });
  }
};

export default config;
