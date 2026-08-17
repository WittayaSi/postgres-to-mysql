import { TableColumn, AISchemaTranslation } from '../types';
import aiDiagnoser from './aiDiagnoser';

export class AISchemaTranslator {
  /**
   * Translates PostgreSQL column schema to optimal MySQL data types with AI advice
   */
  translateSchema(tableName: string, pgColumns: TableColumn[], primaryKeys: string[] = []): AISchemaTranslation {
    const recommendedMysqlTypes: Record<string, string> = {};
    const warnings: string[] = [];
    const suggestedPrimaryKeys: string[] = [...primaryKeys];

    for (const col of pgColumns) {
      const colName = col.column_name;
      const pgType = col.data_type.toLowerCase();
      const len = col.character_maximum_length;
      const isPk = primaryKeys.includes(colName);

      // Primary Key String Handling
      if (isPk && (pgType === 'character varying' || pgType === 'varchar' || pgType === 'text')) {
        recommendedMysqlTypes[colName] = `VARCHAR(${Math.min(len || 255, 255)})`;
        continue;
      }

      switch (pgType) {
        case 'jsonb':
        case 'json':
          recommendedMysqlTypes[colName] = 'JSON';
          warnings.push(`Column '${colName}' uses JSON data type in MySQL. PostgreSQL JSONB indexes cannot be directly migrated.`);
          break;

        case 'uuid':
          recommendedMysqlTypes[colName] = 'VARCHAR(36)';
          warnings.push(`Column '${colName}' translated from PostgreSQL UUID to MySQL VARCHAR(36).`);
          break;

        case 'bytea':
          recommendedMysqlTypes[colName] = 'BLOB';
          warnings.push(`Column '${colName}' translated from PostgreSQL BYTEA to MySQL BLOB.`);
          break;

        case 'boolean':
          recommendedMysqlTypes[colName] = 'TINYINT(1)';
          break;

        case 'character varying':
        case 'varchar':
          if (len && len <= 50) {
            recommendedMysqlTypes[colName] = `VARCHAR(${len})`;
          } else {
            recommendedMysqlTypes[colName] = 'TEXT';
            warnings.push(`Column '${colName}' converted to TEXT in MySQL to prevent InnoDB row length limit (65,535 bytes).`);
          }
          break;

        case 'timestamp':
        case 'timestamp without time zone':
        case 'timestamp with time zone':
          recommendedMysqlTypes[colName] = 'DATETIME';
          if (pgType.includes('with time zone')) {
            warnings.push(`Column '${colName}' has timezone info in PostgreSQL. Converted to DATETIME in MySQL (ensure server timezones match).`);
          }
          break;

        case 'numeric':
        case 'decimal':
          recommendedMysqlTypes[colName] = `DECIMAL(${col.numeric_precision || 10}, ${col.numeric_scale || 2})`;
          break;

        default:
          if (pgType.includes('[]') || pgType.includes('array')) {
            recommendedMysqlTypes[colName] = 'JSON';
            warnings.push(`Array column '${colName}' (${pgType}) converted to JSON array in MySQL.`);
          } else {
            recommendedMysqlTypes[colName] = 'TEXT';
          }
          break;
      }
    }

    // Primary key detection heuristic if no PK is defined
    if (suggestedPrimaryKeys.length === 0) {
      const candidates = pgColumns.filter(c => {
        const name = c.column_name.toLowerCase();
        return name === 'id' || name === `${tableName.toLowerCase()}_id` || name === 'code' || name === 'vn' || name === 'an';
      });
      if (candidates.length > 0) {
        suggestedPrimaryKeys.push(candidates[0].column_name);
        warnings.push(`No Primary Key defined in PostgreSQL for '${tableName}'. Recommended candidate PK: '${candidates[0].column_name}'.`);
      } else {
        warnings.push(`Table '${tableName}' has no Primary Key. System will use TRUNCATE + INSERT mode instead of UPSERT.`);
      }
    }

    return {
      tableName,
      pgColumns,
      recommendedMysqlTypes,
      warnings,
      suggestedPrimaryKeys,
      aiProvider: aiDiagnoser.getProvider(),
    };
  }
}

export default new AISchemaTranslator();
