import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { LogEntry } from '../types';

// Create logs directory if not exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Store recent logs in memory for API access
const recentLogs: LogEntry[] = [];
const MAX_RECENT_LOGS = 100;

// Custom logger interface extending winston.Logger
interface CustomLogger extends winston.Logger {
  getRecentLogs: () => LogEntry[];
  clearRecentLogs: () => void;
}

const baseLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let msg = `${timestamp} [${level.toUpperCase()}] ${message}`;
      if (Object.keys(meta).length > 0) {
        msg += ` ${JSON.stringify(meta)}`;
      }
      return msg;
    })
  ),
  transports: [
    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} [${level}] ${message}`;
        })
      )
    }),
    // File output - all logs
    new winston.transports.File({
      filename: path.join(logsDir, 'transfer.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 3,
      tailable: true,
    }),
    // File output - errors only
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 3,
      tailable: true,
    }),
  ],
});

// Wrap the log method to capture recent logs
const originalLog = baseLogger.log.bind(baseLogger);
baseLogger.log = function(
  levelOrEntry: string | winston.LogEntry,
  messageOrMeta?: string | Error | object,
  ...args: unknown[]
): winston.Logger {
  const logEntry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: typeof levelOrEntry === 'string' ? levelOrEntry : levelOrEntry.level || 'info',
    message: typeof levelOrEntry === 'string' 
      ? (typeof messageOrMeta === 'string' ? messageOrMeta : String(messageOrMeta || ''))
      : (levelOrEntry.message || ''),
  };
  
  recentLogs.unshift(logEntry);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.pop();
  }
  
  // Call original with proper typing
  if (typeof levelOrEntry === 'object') {
    return originalLog(levelOrEntry);
  }
  return originalLog(levelOrEntry, messageOrMeta as string, ...args);
};

// Create custom logger with additional methods
const logger = baseLogger as CustomLogger;
logger.getRecentLogs = (): LogEntry[] => [...recentLogs];
logger.clearRecentLogs = (): void => { recentLogs.length = 0; };

export default logger;
