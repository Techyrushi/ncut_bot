import { BulkCampaign, BulkCampaignRecipient } from '../../database/models/bulk-campaign.model';
import { Conversation } from '../../database/models/conversation.model';
import { Customer } from '../../database/models/customer.model';
import { Message } from '../../database/models/message.model';
import { logger } from '../../config/logger';
import { recordSystemActivity } from '../logs/activity-log';
import { whatsappService } from '../whatsapp/whatsapp.service';

let workerBusy = false;
let lastRecoveryAt = 0;

export async function recoverInterruptedCampaignSends(): Promise<void> {
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const result = await BulkCampaignRecipient.updateMany(
    { status: 'SENDING', updatedAt: { $lt: staleBefore } },
    {
      $set: {
        status: 'FAILED',
        eligible: false,
        lastError: 'The send worker stopped before recording a result. Delivery is unknown; verify WhatsApp before resending.',
      },
    },
  );
  if (result.modifiedCount) {
    await recordSystemActivity(
      'BULK_CAMPAIGN_SENDS_RECOVERED',
      `${result.modifiedCount} interrupted campaign send(s) were flagged for manual verification`,
    );
  }
}

async function updateCampaignCompletion(campaignId: string): Promise<void> {
  const pending = await BulkCampaignRecipient.exists({
    campaignId,
    status: { $in: ['QUEUED', 'SENDING'] },
  });
  if (!pending) {
    await BulkCampaign.updateOne(
      { _id: campaignId, status: 'PROCESSING' },
      { $set: { status: 'COMPLETED', completedAt: new Date() } },
    );
  }
}

async function processOneRecipient(): Promise<void> {
  let campaign = await BulkCampaign.findOneAndUpdate(
    { status: 'QUEUED' },
    { $set: { status: 'PROCESSING' } },
    { new: true, sort: { createdAt: 1 } },
  );
  if (!campaign) campaign = await BulkCampaign.findOne({ status: 'PROCESSING' }).sort({ createdAt: 1 });
  if (!campaign) return;

  const recipient = await BulkCampaignRecipient.findOneAndUpdate(
    { campaignId: campaign._id, status: 'QUEUED' },
    { $set: { status: 'SENDING' }, $inc: { attempts: 1 } },
    { new: true, sort: { sourceRow: 1 } },
  );
  if (!recipient) {
    await updateCampaignCompletion(campaign.id);
    return;
  }

  let acceptedMessageId: string | undefined;
  try {
    const customer = recipient.customerId ? await Customer.findById(recipient.customerId) : null;
    if (!customer || customer.optInStatus !== 'OPTED_IN') {
      await BulkCampaignRecipient.updateOne(
        { _id: recipient._id },
        { $set: { status: 'UNSENT', eligible: false, reason: 'Customer is missing or no longer opted in' } },
      );
      return;
    }

    const conversation = await Conversation.findOne({
      customerId: customer._id,
      status: { $in: ['OPEN', 'HUMAN_HANDOVER'] },
      lastInteractionAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    }).sort({ lastInteractionAt: -1 });
    if (!conversation) {
      await BulkCampaignRecipient.updateOne(
        { _id: recipient._id },
        {
          $set: {
            status: 'UNSENT',
            eligible: false,
            reason: '24-hour service window expired; an approved template flow is required',
          },
        },
      );
      return;
    }

    const attachment = campaign.attachment;
    const to = customer.whatsappId;
    let whatsappMessageId: string;
    let messageType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    const text = campaign.message;
    if (!attachment) {
      whatsappMessageId = await whatsappService.sendText(to, text);
      messageType = 'TEXT';
    } else if (attachment.type === 'IMAGE') {
      whatsappMessageId = await whatsappService.sendImage(to, attachment.url, text || undefined);
      messageType = 'IMAGE';
    } else if (attachment.type === 'VIDEO') {
      whatsappMessageId = await whatsappService.sendVideo(to, attachment.url, text || undefined);
      messageType = 'VIDEO';
    } else {
      whatsappMessageId = await whatsappService.sendDocument(
        to,
        attachment.url,
        attachment.filename,
        text || undefined,
      );
      messageType = 'DOCUMENT';
    }
    acceptedMessageId = whatsappMessageId;

    const message = await Message.create({
      customerId: customer._id,
      conversationId: conversation._id,
      whatsappMessageId,
      bulkCampaignId: campaign._id,
      bulkRecipientId: recipient._id,
      direction: 'OUTBOUND',
      messageType,
      content: attachment
        ? { text, [attachment.type.toLowerCase()]: { url: attachment.url, filename: attachment.filename } }
        : { text },
      status: 'SENT',
      timestamp: new Date(),
    });
    await BulkCampaignRecipient.updateOne(
      { _id: recipient._id, status: 'SENDING' },
      {
        $set: {
          status: 'SENT',
          messageId: message._id,
          whatsappMessageId,
          sentAt: new Date(),
          reason: '',
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown WhatsApp send error';
    await BulkCampaignRecipient.updateOne(
      { _id: recipient._id, status: 'SENDING' },
      {
        $set: {
          status: 'FAILED',
          ...(acceptedMessageId ? { whatsappMessageId: acceptedMessageId } : {}),
          lastError: (
            acceptedMessageId
              ? `WhatsApp accepted the send (${acceptedMessageId}), but local tracking did not finish. Verify delivery before resending. ${message}`
              : `Send failed or its outcome is unknown. Verify WhatsApp before resending. ${message}`
          ).slice(0, 500),
        },
      },
    );
    logger.error(
      { err: error, campaignId: campaign.id, recipientId: recipient.id },
      'Bulk WhatsApp recipient send failed',
    );
  } finally {
    await updateCampaignCompletion(campaign.id);
  }
}

export async function processBulkCampaignQueue(): Promise<void> {
  if (workerBusy) return;
  workerBusy = true;
  try {
    if (Date.now() - lastRecoveryAt > 30_000) {
      await recoverInterruptedCampaignSends();
      lastRecoveryAt = Date.now();
    }
    await processOneRecipient();
  } finally {
    workerBusy = false;
  }
}

export function startBulkCampaignWorker(): NodeJS.Timeout {
  return setInterval(() => {
    void processBulkCampaignQueue().catch((error: unknown) =>
      logger.error({ err: error }, 'Bulk campaign worker cycle failed'),
    );
  }, 1000);
}
