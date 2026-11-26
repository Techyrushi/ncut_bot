import { app } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { connectDatabase } from './database/connect';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { startWebhookWorker } from './modules/webhook/webhook.processor';
import { initializeAdminUser } from './modules/auth/bootstrap';
import { recordSystemActivity } from './modules/logs/activity-log';
import { recoverInterruptedCampaignSends, startBulkCampaignWorker } from './modules/bulk-campaigns/bulk-campaign.service';
import { Lead } from './database/models/lead.model';
import { WorkspaceSettings } from './database/models/workspace-settings.model';
import { Customer, normalizePhoneIdentity } from './database/models/customer.model';
import { Conversation } from './database/models/conversation.model';
import { Message } from './database/models/message.model';

async function start(): Promise<void> {
  await connectDatabase();
  await backfillCustomerPhoneIdentity();
  await backfillLastInboundMessageAt();
  await initializeLeadReadTracking();
  await initializeAdminUser();
  await recoverInterruptedCampaignSends();
  await recordSystemActivity('API_STARTED', 'Backend connected to the database and started');
  const worker = startWebhookWorker();
  worker.unref();
  const campaignWorker = startBulkCampaignWorker();
  campaignWorker.unref();
  const server = app.listen(env.PORT, env.HOST, () =>
    logger.info({ host: env.HOST, port: env.PORT }, 'HTTP server listening'),
  );
  registerShutdown(server, worker, campaignWorker);
}

async function backfillLastInboundMessageAt(): Promise<void> {
  const conversations: unknown[] = [];
  const flush = async (): Promise<void> => {
    if (!conversations.length) return;
    const ids = conversations.splice(0);
    const latestInbound = await Message.aggregate<{ _id: mongoose.Types.ObjectId; timestamp: Date }>([
      { $match: { conversationId: { $in: ids }, direction: 'INBOUND' } },
      { $group: { _id: '$conversationId', timestamp: { $max: '$timestamp' } } },
    ]);
    if (!latestInbound.length) return;
    await Conversation.bulkWrite(
      latestInbound.map(({ _id, timestamp }) => ({
        updateOne: {
          filter: { _id, lastInboundMessageAt: { $exists: false } },
          update: { $set: { lastInboundMessageAt: timestamp } },
        },
      })),
    );
  };
  for await (const conversation of Conversation.find({ lastInboundMessageAt: { $exists: false } })
    .select('_id')
    .cursor()) {
    conversations.push(conversation._id);
    if (conversations.length >= 500) await flush();
  }
  await flush();
}

async function backfillCustomerPhoneIdentity(): Promise<void> {
  const operations: Array<{
    updateOne: { filter: { _id: unknown }; update: { $set: { phoneIdentity: string } } };
  }> = [];
  const flush = async (): Promise<void> => {
    if (!operations.length) return;
    await Customer.bulkWrite(operations.splice(0));
  };
  for await (const customer of Customer.find({ phoneIdentity: { $exists: false } })
    .select('_id phoneNumber whatsappId')
    .cursor()) {
    const phoneIdentity = normalizePhoneIdentity(customer.phoneNumber || customer.whatsappId);
    if (!phoneIdentity) continue;
    operations.push({
      updateOne: {
        filter: { _id: customer._id },
        update: { $set: { phoneIdentity } },
      },
    });
    if (operations.length >= 500) await flush();
  }
  await flush();
}

async function initializeLeadReadTracking(): Promise<void> {
  const settings = await WorkspaceSettings.findOne({ key: 'workspace' }).select('leadNotificationSetupAt').lean();
  if (settings?.leadNotificationSetupAt) return;
  await Lead.updateMany(
    { adminReadAt: { $exists: false } },
    [{ $set: { adminReadAt: { $ifNull: ['$updatedAt', '$createdAt'] } } }],
  );
  await WorkspaceSettings.updateOne(
    { key: 'workspace' },
    { $set: { leadNotificationSetupAt: new Date() } },
    { upsert: true },
  );
}

function registerShutdown(server: Server, worker: NodeJS.Timeout, campaignWorker: NodeJS.Timeout): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown started');
    clearInterval(worker);
    clearInterval(campaignWorker);
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
