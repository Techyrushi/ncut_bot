import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { WebhookEvent } from '../../database/models/webhook-event.model';
import { Message } from '../../database/models/message.model';
import { automationService } from '../automation/automation.service';

type WebhookChange = {
  value?: {
    messages?: Array<Record<string, unknown>>;
    statuses?: Array<Record<string, unknown>>;
    contacts?: Array<{ profile?: { name?: string }; wa_id?: string; user_id?: string }>;
  };
};

export function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.WHATSAPP_APP_SECRET || !signature?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature.slice(7), 'hex');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function eventId(type: string, item: Record<string, unknown>): string {
  const canonical = JSON.stringify(item);
  const identity = typeof item.id === 'string' ? item.id : createHash('sha256').update(canonical).digest('hex');
  const statusPart = typeof item.status === 'string' ? `:${item.status}:${String(item.timestamp ?? '')}` : '';
  return `${type}:${identity}${statusPart}`;
}

export async function enqueueWebhookPayload(payload: unknown): Promise<number> {
  if (!payload || typeof payload !== 'object' || !('entry' in payload) || !Array.isArray(payload.entry)) {
    throw new Error('Invalid WhatsApp webhook payload');
  }
  const work: Array<{ eventId: string; eventType: string; payload: Record<string, unknown> }> = [];
  for (const entry of payload.entry as Array<{ changes?: WebhookChange[] }>) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      for (const message of value.messages ?? []) {
        work.push({
          eventId: eventId('message', message),
          eventType: 'message',
          payload: { message, contacts: value.contacts ?? [] },
        });
      }
      for (const status of value.statuses ?? []) {
        work.push({ eventId: eventId('status', status), eventType: 'status', payload: status });
      }
    }
  }
  if (work.length) {
    try {
      await WebhookEvent.bulkWrite(
        work.map((event) => ({
          updateOne: {
            filter: { eventId: event.eventId },
            update: {
              $setOnInsert: {
                ...event,
                processingStatus: 'PENDING' as const,
                receivedAt: new Date(),
                availableAt: new Date(),
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    } catch (error) {
      const writeErrors = (error as { writeErrors?: Array<{ code?: number }> }).writeErrors;
      if (!writeErrors?.length || writeErrors.some((writeError) => writeError.code !== 11000)) throw error;
    }
  }
  return work.length;
}

async function processStatus(payload: Record<string, unknown>): Promise<void> {
  const statuses = ['sent', 'delivered', 'read', 'failed'];
  const messageId = payload.id;
  const status = payload.status;
  if (typeof messageId !== 'string' || typeof status !== 'string' || !statuses.includes(status)) return;
  const message = await Message.findOneAndUpdate(
    { whatsappMessageId: messageId },
    { $set: { status: status.toUpperCase(), ...(payload.errors ? { error: payload.errors } : {}) } },
    { new: true },
  );
  if (!message) throw new Error(`Status update for message ${messageId} arrived before its local message record`);
}

async function processEvent(eventIdValue: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  if (eventType === 'status') {
    await processStatus(payload);
    return;
  }
  const message = payload.message as Parameters<typeof automationService.processIncoming>[0];
  if (
    !message ||
    (typeof message.from !== 'string' && typeof message.from_user_id !== 'string') ||
    typeof message.id !== 'string'
  )
    return;
  const contacts = payload.contacts as Array<{ profile?: { name?: string }; wa_id?: string; user_id?: string }>;
  const profileName = contacts?.find(
    (contact) =>
      (typeof message.from === 'string' && contact.wa_id === message.from) ||
      (typeof message.from_user_id === 'string' && contact.user_id === message.from_user_id),
  )?.profile?.name;
  await automationService.processIncoming(message, profileName);
  void eventIdValue;
}

export async function processPendingWebhookEvents(batchSize = 25): Promise<void> {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  await WebhookEvent.updateMany(
    { processingStatus: 'PROCESSING', lockedAt: { $lt: staleBefore } },
    { $set: { processingStatus: 'PENDING', availableAt: new Date() }, $unset: { lockedAt: 1 } },
  );
  for (let index = 0; index < batchSize; index += 1) {
    const event = await WebhookEvent.findOneAndUpdate(
      { processingStatus: 'PENDING', availableAt: { $lte: new Date() } },
      { $set: { processingStatus: 'PROCESSING', lockedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { receivedAt: 1 }, new: true },
    );
    if (!event) return;
    try {
      await processEvent(event.eventId, event.eventType, event.payload as Record<string, unknown>);
      await WebhookEvent.updateOne(
        { _id: event._id },
        { $set: { processingStatus: 'PROCESSED', processedAt: new Date() }, $unset: { lastError: 1, lockedAt: 1 } },
      );
    } catch (error) {
      const exhausted = event.attempts >= env.WEBHOOK_MAX_ATTEMPTS;
      await WebhookEvent.updateOne(
        { _id: event._id },
        {
          $set: {
            processingStatus: exhausted ? 'FAILED' : 'PENDING',
            availableAt: new Date(Date.now() + Math.min(2 ** event.attempts * 1000, 60 * 1000)),
            lastError: error instanceof Error ? error.message : 'Unknown processing error',
          },
          $unset: { lockedAt: 1 },
        },
      );
      logger.error({ err: error, eventId: event.eventId, attempts: event.attempts }, 'Webhook event processing failed');
      if (!exhausted) return;
    }
  }
}

export function startWebhookWorker(): NodeJS.Timeout {
  return setInterval(() => {
    void processPendingWebhookEvents().catch((error: unknown) =>
      logger.error({ err: error }, 'Webhook worker cycle failed'),
    );
  }, env.WEBHOOK_PROCESSING_INTERVAL_MS);
}
