import logger from './logger';

const MAX_RETRIES = parseInt(process.env.DB_RETRY_COUNT || '3');
const RETRY_DELAY_MS = parseInt(process.env.DB_RETRY_DELAY_MS || '2000');

// Error codes that indicate a connection issue (worth retrying)
const RETRYABLE_ERRORS = [
  // PostgreSQL
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  'CONNECTION_LOST', 'PROTOCOL_CONNECTION_LOST',
  '57P01',  // admin_shutdown
  '57P03',  // cannot_connect_now
  '08006',  // connection_failure
  '08001',  // sqlclient_unable_to_establish_sqlconnection
  '08004',  // sqlserver_rejected_establishment_of_sqlconnection
  // MySQL
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ER_SERVER_SHUTDOWN', 'ER_FORCING_CLOSE',
  'ER_CON_COUNT_ERROR', 'ER_ABORTING_CONNECTION',
];

function isRetryableError(error: Error & { code?: string; errno?: number }): boolean {
  const code = error.code || '';
  const message = error.message || '';
  
  if (RETRYABLE_ERRORS.includes(code)) return true;
  if (message.includes('Connection lost')) return true;
  if (message.includes('connect ECONNREFUSED')) return true;
  if (message.includes('connect ETIMEDOUT')) return true;
  if (message.includes('Connection was destroyed')) return true;
  if (message.includes('Cannot enqueue')) return true;
  
  return false;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  context: string = 'query'
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      const err = error as Error & { code?: string };
      
      if (attempt <= MAX_RETRIES && isRetryableError(err)) {
        const waitMs = RETRY_DELAY_MS * attempt; // Exponential-ish backoff
        logger.warn(`[Retry] ${context} failed (attempt ${attempt}/${MAX_RETRIES + 1}): ${err.message.substring(0, 100)}. Retrying in ${waitMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      } else {
        throw error;
      }
    }
  }
  
  throw lastError;
}

export default withRetry;
