import dotenv from 'dotenv';
dotenv.config();

import express, { Application, Request, Response } from 'express';
import http from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import path from 'path';
import config from './src/config';
import apiRoutes from './src/api/routes';
import jobScheduler from './src/scheduler/jobScheduler';
import transferEngine from './src/transfer/transferEngine';
import logger from './src/utils/logger';
import postgres from './src/connectors/postgres';
import mysql from './src/connectors/mysql';

const app: Application = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Resolve public dir relative to project root (not __dirname which differs in dist/)
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// API routes
app.use('/api', apiRoutes);

// Socket.IO for real-time updates
io.on('connection', (socket: Socket) => {
  logger.info('Client connected');
  
  // Send current status on connect
  socket.emit('status', transferEngine.getAllStatuses());
  
  socket.on('disconnect', () => {
    logger.info('Client disconnected');
  });
});

// Broadcast transfer status every second (only if clients connected)
setInterval(() => {
  if (io.sockets.sockets.size === 0) return;
  const statuses = transferEngine.getAllStatuses();
  const hasRunning = Object.values(statuses).some(s => s && s.isRunning);
  if (hasRunning) {
    io.emit('status', statuses);
  }
}, 1000);

// Periodic cleanup of stale worker statuses (every 15 min)
setInterval(() => {
  transferEngine.cleanupStaleWorkers();
}, 15 * 60 * 1000);

// Serve index.html for root
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Serve integrity check page
app.get('/integrity', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'integrity.html'));
});

// Start server
const PORT = config.server.port;
server.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`);
  
  // Start scheduler
  jobScheduler.start();
});

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received. Shutting down...`);
  jobScheduler.stop();
  
  // Wait for currently active table transfers to finish safely (up to 30s timeout inside Engine)
  await transferEngine.shutdown();
  
  await postgres.close();
  await mysql.close();
  
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
