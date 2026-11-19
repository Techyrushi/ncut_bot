import { app } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { connectDatabase } from './database/connect';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { startWebhookWorker } from './modules/webhook/webhook.processor';
import { initializeAdminUser } from './modules/auth/bootstrap';
import { recordSystemActivity } from './modules/logs/activity-log';

async function start(): Promise<void> {
  await connectDatabase();
  await initializeAdminUser();
  await recordSystemActivity('API_STARTED', 'Backend connected to the database and started');
  const worker = startWebhookWorker();
  worker.unref();
  const server = app.listen(env.PORT, env.HOST, () =>
    logger.info({ host: env.HOST, port: env.PORT }, 'HTTP server listening'),
  );
  registerShutdown(server, worker);
}

function registerShutdown(server: Server, worker: NodeJS.Timeout): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown started');
    clearInterval(worker);
    void recordSystemActivity('API_STOPPED', `Backend shutdown requested (${signal})`).finally(() => {
      server.close((error) => {
        if (error) {
          logger.error({ err: error }, 'HTTP server shutdown failed');
          process.exitCode = 1;
        }
        void mongoose.disconnect().catch((disconnectError: unknown) => {
          logger.error({ err: disconnectError }, 'MongoDB shutdown failed');
          process.exitCode = 1;
        });
      });
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Application startup failed');
  process.exitCode = 1;
});
