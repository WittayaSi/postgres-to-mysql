import axios from 'axios';
import logger from '../utils/logger';
import { AIDiagnosisResult } from '../types';

export class AIDiagnoser {
  private geminiApiKey: string | undefined;
  private openAiApiKey: string | undefined;

  constructor() {
    this.geminiApiKey = process.env.GEMINI_API_KEY;
    this.openAiApiKey = process.env.OPENAI_API_KEY;
  }

  /**
   * Get active AI Provider
   */
  getProvider(): 'gemini' | 'openai' | 'rule_engine' {
    if (this.geminiApiKey) return 'gemini';
    if (this.openAiApiKey) return 'openai';
    return 'rule_engine';
  }

  /**
   * Main entry point to diagnose transfer/system error
   */
  async diagnoseError(errorMessage: string, tableName?: string, contextData?: any): Promise<AIDiagnosisResult> {
    const provider = this.getProvider();
    
    if (provider === 'gemini') {
      try {
        return await this.diagnoseWithGemini(errorMessage, tableName, contextData);
      } catch (err) {
        logger.warn(`[AI] Gemini API diagnosis failed, falling back to rule engine: ${(err as Error).message}`);
      }
    } else if (provider === 'openai') {
      try {
        return await this.diagnoseWithOpenAI(errorMessage, tableName, contextData);
      } catch (err) {
        logger.warn(`[AI] OpenAI API diagnosis failed, falling back to rule engine: ${(err as Error).message}`);
      }
    }

    // Default: Fallback to built-in rule engine
    return this.diagnoseWithRuleEngine(errorMessage, tableName, contextData);
  }

  /**
   * Rule-based diagnostic heuristics (Fast, offline, 100% reliable)
   */
  private diagnoseWithRuleEngine(errorMessage: string, tableName?: string, contextData?: any): AIDiagnosisResult {
    const msg = errorMessage.toLowerCase();
    const tableStr = tableName ? `[Table: ${tableName}] ` : '';

    let category: AIDiagnosisResult['category'] = 'unknown';
    let summary = `${tableStr}An unexpected error occurred during sync execution.`;
    let rootCause = errorMessage;
    let recommendations: string[] = ['Inspect application server logs and check database connection parameters.'];
    let suggestedAction = 'Review database status and retry transfer.';

    if (msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('access denied') || msg.includes('connect failed')) {
      category = 'database_connection';
      summary = `${tableStr}Database connection failed or timed out.`;
      rootCause = 'Target/Source database host is unreachable, credentials are invalid, or network firewall is blocking the connection.';
      recommendations = [
        'Check PG_HOST, PG_PORT, MYSQL_HOST, MYSQL_PORT in your .env file.',
        'Verify PostgreSQL and MySQL services are running on the server.',
        'Ensure firewall ports (5432 and 3306) are open.'
      ];
      suggestedAction = 'Test database connection via API /api/settings/test-connection.';
    } else if (msg.includes('er_dup_entry') || msg.includes('duplicate key') || msg.includes('unique constraint')) {
      category = 'duplicate_entry';
      summary = `${tableStr}Duplicate entry constraint violation detected in MySQL.`;
      rootCause = 'Multiple rows in PostgreSQL share the same Primary Key value or unique index column.';
      recommendations = [
        'Verify Primary Key column definition in PostgreSQL.',
        'Check if duplicate records exist in source PostgreSQL table.',
        'Consider enabling skipOrphanCleanup or revising primary key definition in tables.json.'
      ];
      suggestedAction = 'Inspect primary key values in target table.';
    } else if (msg.includes('row size too large') || msg.includes('er_too_big_rowsize')) {
      category = 'row_size_exceeded';
      summary = `${tableStr}MySQL max row size limit (65,535 bytes) exceeded.`;
      rootCause = 'Table has too many VARCHAR columns. In MySQL, the maximum combined row size limit is 65,535 bytes.';
      recommendations = [
        'Convert large VARCHAR columns (>50 chars) to TEXT datatype.',
        'Ensure ROW_FORMAT=DYNAMIC is used when creating MySQL tables.'
      ];
      suggestedAction = 'System auto-converts long VARCHARs to TEXT in latest mysql.ts connector.';
    } else if (msg.includes('er_data_too_long') || msg.includes('truncated')) {
      category = 'schema_mismatch';
      summary = `${tableStr}Data length exceeds target MySQL column size.`;
      rootCause = 'PostgreSQL column contains string data longer than the defined MySQL column length limit.';
      recommendations = [
        'Alter MySQL column type to TEXT or MEDIUMTEXT.',
        'Verify string column lengths in PostgreSQL metadata.'
      ];
      suggestedAction = 'Run schema sync via mysqlConnector.syncTableSchema.';
    } else if (msg.includes('expected comma') || msg.includes('syntaxerror') || msg.includes('json')) {
      category = 'syntax_error';
      summary = `JSON configuration syntax error detected in config/tables.json.`;
      rootCause = 'Syntax formatting error in config/tables.json file (e.g. missing comma or bracket).';
      recommendations = [
        'Run syntax check: node -e "JSON.parse(require(\'fs\').readFileSync(\'config/tables.json\'))"',
        'Ensure object entries inside tables.json are separated by commas.'
      ];
      suggestedAction = 'Fix JSON syntax error in config/tables.json.';
    }

    return {
      errorSummary: summary,
      category,
      rootCause,
      recommendations,
      suggestedAction,
      aiProvider: 'rule_engine',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Gemini API Diagnostic Integration
   */
  private async diagnoseWithGemini(errorMessage: string, tableName?: string, contextData?: any): Promise<AIDiagnosisResult> {
    const prompt = `You are an expert PostgreSQL and MySQL database synchronization diagnostic assistant.
Analyze this error and return a JSON object ONLY:
Error: "${errorMessage}"
Table: "${tableName || 'N/A'}"
Context: ${JSON.stringify(contextData || {})}

JSON Schema to return:
{
  "errorSummary": "short summary",
  "category": "database_connection" | "primary_key_missing" | "schema_mismatch" | "row_size_exceeded" | "duplicate_entry" | "syntax_error" | "unknown",
  "rootCause": "detailed cause",
  "recommendations": ["step 1", "step 2"],
  "suggestedAction": "action"
}`;

    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.geminiApiKey}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleanJson = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    return {
      errorSummary: parsed.errorSummary || 'AI diagnostic completed.',
      category: parsed.category || 'unknown',
      rootCause: parsed.rootCause || errorMessage,
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : ['Check system logs'],
      suggestedAction: parsed.suggestedAction || 'Review logs',
      aiProvider: 'gemini',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * OpenAI API Diagnostic Integration
   */
  private async diagnoseWithOpenAI(errorMessage: string, tableName?: string, contextData?: any): Promise<AIDiagnosisResult> {
    const prompt = `Analyze this database sync error and return JSON only:
Error: "${errorMessage}"
Table: "${tableName || 'N/A'}"

Return JSON matching:
{
  "errorSummary": "string",
  "category": "database_connection" | "primary_key_missing" | "schema_mismatch" | "row_size_exceeded" | "duplicate_entry" | "syntax_error" | "unknown",
  "rootCause": "string",
  "recommendations": ["string"],
  "suggestedAction": "string"
}`;

    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      },
      {
        headers: {
          'Authorization': `Bearer ${this.openAiApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const text = res.data?.choices?.[0]?.message?.content || '';
    const cleanJson = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    return {
      errorSummary: parsed.errorSummary || 'AI diagnostic completed.',
      category: parsed.category || 'unknown',
      rootCause: parsed.rootCause || errorMessage,
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : ['Check system logs'],
      suggestedAction: parsed.suggestedAction || 'Review logs',
      aiProvider: 'openai',
      timestamp: new Date().toISOString(),
    };
  }
}

export default new AIDiagnoser();
