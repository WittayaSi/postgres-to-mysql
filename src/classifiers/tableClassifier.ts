import postgres from '../connectors/postgres';
import config from '../config';
import logger from '../utils/logger';
import { ClassifiedTable, ClassifiedTables, TableSummary, TableFilter, TablesConfig } from '../types';

class TableClassifier {
  private classified: ClassifiedTables | null = null;

  async classify(includeRowCounts: boolean = false): Promise<ClassifiedTables> {
    // If counts requested, always refetch (don't use cache)
    // If no counts and cache exists, use cache
    if (!includeRowCounts && this.classified) return this.classified;
    
    logger.info('Starting table classification...');
    
    const tables = await postgres.getTables();
    const tablesConfig = config.getTablesConfig();
    
    const result: ClassifiedTables = {
      basic: [],
      opd: [],
      ipd: [],
    };
    
    for (const tableName of tables) {
      const columns = await postgres.getTableColumns(tableName);
      const columnNames = columns.map(c => c.column_name.toLowerCase());
      
      const hasVn = columnNames.includes('vn');
      const hasAn = columnNames.includes('an');
      
      let rowCount = 0;
      if (includeRowCounts) {
        try {
          rowCount = await postgres.countRows(tableName);
        } catch (e) {
          const err = e as Error;
          logger.error(`Failed to count rows for ${tableName}`, { error: err.message });
        }
      }
      
      const tableEntry: ClassifiedTable = {
        name: tableName,
        columns: columns,
        hasVn,
        hasAn,
        rowCount,
      };
      
      // 4-Layer Smart Classification Architecture
      const nameLower = tableName.toLowerCase();
      
      // Layer 1: Check Explicit Overrides in tables.json
      const isExplicitIpd = tablesConfig.ipd.tableConfigs?.[tableName] !== undefined;
      const isExplicitOpd = tablesConfig.opd.tableConfigs?.[tableName] !== undefined;
      const isExplicitBasic = tablesConfig.basic.tableConfigs?.[tableName] !== undefined;

      // Layer 2: IPD Domain Patterns (ipt, an_, ipd_, ward_, bed_, or hasAn)
      const isIpdPattern = nameLower.startsWith('ipt') || 
                           nameLower.startsWith('an_') || 
                           nameLower.startsWith('ipd_') || 
                           nameLower.startsWith('ward_') || 
                           nameLower.startsWith('bed_') ||
                           nameLower.includes('_ipd') || 
                           hasAn;

      // Known IPD transactional FK columns
      const ipdFkCols = ['ipd_doctor_order_id', 'ipd_doctor_order_detail_id', 'ipt_id', 'ipt_admit_id', 'an_stat_id'];
      const hasIpdFk = ipdFkCols.some(col => columnNames.includes(col));

      const isIpdMember = isExplicitIpd || (isIpdPattern && (hasAn || hasIpdFk || isExplicitIpd)) || hasAn || hasIpdFk;
      const isOpdMember = isExplicitOpd || hasVn;

      if (isIpdMember && !isExplicitBasic && !isExplicitOpd && this.shouldInclude(tableName, tablesConfig.ipd.tables)) {
        // IPD Transactional Group (has AN or IPD Foreign Key)
        result.ipd.push({ ...tableEntry, config: tablesConfig.ipd.tableConfigs?.[tableName] });
      }

      if (isOpdMember && !isExplicitBasic && !isExplicitIpd && this.shouldInclude(tableName, tablesConfig.opd.tables)) {
        // OPD Group (has VN)
        result.opd.push({ ...tableEntry, config: tablesConfig.opd.tableConfigs?.[tableName] });
      }

      if (!result.ipd.some(t => t.name === tableName) && !result.opd.some(t => t.name === tableName) && this.shouldInclude(tableName, tablesConfig.basic.tables)) {
        // Basic Group (Setup, reference, master tables)
        result.basic.push({ ...tableEntry, config: tablesConfig.basic.tableConfigs?.[tableName] });
      }
    }
    
    logger.info(`Classification complete: Basic=${result.basic.length}, OPD=${result.opd.length}, IPD=${result.ipd.length}`);
    
    // Auto-create MySQL tables if they don't exist
    if (!includeRowCounts) {
      this.classified = result;
      
      // Run auto-create in background
      this.autoCreateTables(result).catch(err => {
        logger.error('Auto-create tables error', { error: err.message });
      });
    }
    return result;
  }
  
  private async autoCreateTables(classified: ClassifiedTables): Promise<void> {
    // Dynamically import to avoid circular dependency issues
    const mysqlModule = await import('../connectors/mysql');
    const mysqlConnector = mysqlModule.default;
    
    const allTables = [...classified.basic, ...classified.opd, ...classified.ipd];
    let created = 0, skipped = 0, errors = 0;
    
    for (const table of allTables) {
      try {
        const exists = await mysqlConnector.tableExists(table.name);
        if (!exists) {
          const primaryKey = await postgres.getPrimaryKey(table.name);
          await mysqlConnector.createTable(table.name, table.columns, primaryKey);
          created++;
        } else {
          skipped++;
        }
      } catch (e) {
        errors++;
        // Silent fail for individual tables
      }
    }
    
    if (created > 0) {
      logger.info(`Auto-created ${created} MySQL tables (${skipped} existed, ${errors} errors)`);
    }
  }

  private shouldInclude(tableName: string, tableConfig: TableFilter): boolean {
    const { include, exclude } = tableConfig;
    
    // Check exclude patterns first
    for (const pattern of exclude) {
      if (this.matchPattern(tableName, pattern)) {
        return false;
      }
    }
    
    // Check include patterns
    for (const pattern of include) {
      if (pattern === '*' || this.matchPattern(tableName, pattern)) {
        return true;
      }
    }
    
    return false;
  }

  private matchPattern(tableName: string, pattern: string): boolean {
    if (pattern === '*') return true;
    
    // Convert glob pattern to regex
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );
    return regex.test(tableName);
  }

  async getBasicTables(): Promise<ClassifiedTable[]> {
    const classified = await this.classify();
    return classified.basic;
  }

  async getOpdTables(): Promise<ClassifiedTable[]> {
    const classified = await this.classify();
    return classified.opd;
  }

  async getIpdTables(): Promise<ClassifiedTable[]> {
    const classified = await this.classify();
    return classified.ipd;
  }

  async getSummary(): Promise<TableSummary> {
    const classified = await this.classify();
    return {
      basic: {
        count: classified.basic.length,
        tables: classified.basic.map(t => t.name),
      },
      opd: {
        count: classified.opd.length,
        tables: classified.opd.map(t => t.name),
      },
      ipd: {
        count: classified.ipd.length,
        tables: classified.ipd.map(t => t.name),
      },
    };
  }

  clearCache(): void {
    this.classified = null;
  }
}

export default new TableClassifier();
