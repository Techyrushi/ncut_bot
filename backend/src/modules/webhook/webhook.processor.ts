import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { recordSystemActivity } from '../logs/activity-log';
import { WebhookEvent } from '../../database/models/webhook-event.model';
import { Message } from '../../database/models/message.model';
import { BulkCampaignRecipient } from '../../database/models/bulk-campaign.model';
import { Lead } from '../../database/models/lead.model';
import { automationService } from '../automation/automation.service';
import { parseWhatsAppTimestamp } from '../whatsapp/service-window';

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
  const statusGuard =
    status === 'sent'
      ? { status: { $nin: ['DELIVERED', 'READ', 'FAILED'] } }
      : status === 'delivered'
        ? { status: { $ne: 'READ' } }
        : status === 'failed'
          ? { status: { $nin: ['DELIVERED', 'READ'] } }
          : {};
  const message =
    (await Message.findOneAndUpdate(
      { whatsappMessageId: messageId, ...statusGuard },
      { $set: { status: status.toUpperCase(), ...(payload.errors ? { error: payload.errors } : {}) } },
      { new: true },
    )) ?? (await Message.findOne({ whatsappMessageId: messageId }));
  if (!message) {
    const recipient = await BulkCampaignRecipient.findOne({ whatsappMessageId: messageId });
    if (!recipient) {
      const messageDeliveryStatusGuard =
        status === 'sent'
          ? { adminNotificationDeliveryStatus: { $nin: ['DELIVERED', 'READ', 'FAILED'] } }
          : status === 'delivered'
            ? { adminNotificationDeliveryStatus: { $ne: 'READ' } }
            : status === 'failed'
              ? { adminNotificationDeliveryStatus: { $nin: ['DELIVERED', 'READ'] } }
              : {};
      const notifiedMessage = await Message.findOneAndUpdate(
        { adminNotificationMessageId: messageId, ...messageDeliveryStatusGuard },
        { $set: { adminNotificationDeliveryStatus: status.toUpperCase() } },
        { new: true },
      );
      if (notifiedMessage) {
        await Lead.updateOne(
          { notificationMessageId: messageId },
          { $set: { notificationDeliveryStatus: status.toUpperCase() } },
        );
        return;
      }
      const deliveryStatusGuard =
        status === 'sent'
          ? { notificationDeliveryStatus: { $nin: ['DELIVERED', 'READ', 'FAILED'] } }
          : status === 'delivered'
            ? { notificationDeliveryStatus: { $ne: 'READ' } }
            : status === 'failed'
              ? { notificationDeliveryStatus: { $nin: ['DELIVERED', 'READ'] } }
              : {};
      const lead = await Lead.findOneAndUpdate(
        { notificationMessageId: messageId, ...deliveryStatusGuard },
        { $set: { notificationDeliveryStatus: status.toUpperCase() } },
        { new: true },
      );
      if (lead) return;
      throw new Error(`Status update for message ${messageId} arrived before its local message record`);
    }
    const recipientUpdate: Record<string, unknown> = { status: status.toUpperCase() };
    const receivedAt =
      typeof payload.timestamp === 'string' || typeof payload.timestamp === 'number'
        ? parseWhatsAppTimestamp(payload.timestamp)
        : new Date();
    if (status === 'delivered') recipientUpdate.deliveredAt = receivedAt;
    if (status === 'read') recipientUpdate.readAt = receivedAt;
    if (status === 'failed') {
      recipientUpdate.lastError = JSON.stringify(payload.errors ?? 'WhatsApp reported delivery failure').slice(0, 500);
    }
    await BulkCampaignRecipient.updateOne(
      { _id: recipient._id, ...statusGuard },
      { $set: recipientUpdate },
    );
    return;
  }
  if (status === 'failed' && message.direction === 'OUTBOUND' && message.deliveryActionStatus) {
    await Message.updateOne(
      { _id: message._id, deliveryActionStatus: { $in: ['PENDING', 'SENDING'] } },
      {
        $set: { deliveryActionStatus: 'FAILED' },
        $unset: { deliveryAction: 1, deliveryActionLockedAt: 1 },
      },
    );
  }
  if (message.bulkRecipientId) {
    const effectiveStatus = String(message.status);
    const update: Record<string, unknown> = { status: effectiveStatus };
    const receivedAt =
      typeof payload.timestamp === 'string' || typeof payload.timestamp === 'number'
        ? parseWhatsAppTimestamp(payload.timestamp)
        : new Date();
    if (status.toUpperCase() === effectiveStatus && effectiveStatus === 'DELIVERED') update.deliveredAt = receivedAt;
    if (status.toUpperCase() === effectiveStatus && effectiveStatus === 'READ') update.readAt = receivedAt;
    if (status.toUpperCase() === effectiveStatus && effectiveStatus === 'FAILED') {
      update.lastError = JSON.stringify(payload.errors ?? 'WhatsApp reported delivery failure').slice(0, 500);
    }
    if (message._id) update.messageId = message._id;
    update.whatsappMessageId = messageId;
    const effectiveGuard =
      effectiveStatus === 'SENT'
        ? { status: { $nin: ['DELIVERED', 'READ', 'FAILED'] } }
        : effectiveStatus === 'DELIVERED'
          ? { status: { $ne: 'READ' } }
          : effectiveStatus === 'FAILED'
            ? { status: { $nin: ['DELIVERED', 'READ'] } }
            : {};
    await BulkCampaignRecipient.updateOne(
      { _id: message.bulkRecipientId, ...effectiveGuard },
      { $set: update },
    );
  }
  if (message.direction === 'OUTBOUND' && !message.bulkRecipientId && (status === 'delivered' || status === 'read')) {
    await automationService.continueAfterDelivery(messageId);
  }
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
      if (exhausted) {
        await recordSystemActivity('WEBHOOK_PROCESSING_FAILED', 'A WhatsApp webhook event exhausted its retry limit');
      } else {
        return;
      }
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
