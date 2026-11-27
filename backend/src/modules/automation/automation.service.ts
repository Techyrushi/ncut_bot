import mongoose, { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { Conversation } from '../../database/models/conversation.model';
import { Customer, normalizePhoneIdentity } from '../../database/models/customer.model';
import { Lead, SALES_FOLLOW_UP_REQUIREMENT } from '../../database/models/lead.model';
import { Message } from '../../database/models/message.model';
import { BulkCampaignRecipient } from '../../database/models/bulk-campaign.model';
import { Product } from '../../database/models/product.model';
import { DEFAULT_WELCOME_MESSAGE, WorkspaceSettings } from '../../database/models/workspace-settings.model';
import { whatsappService } from '../whatsapp/whatsapp.service';
import { webPushService, isWebPushConfigured } from '../push/web-push.service';
import { parseWhatsAppTimestamp } from '../whatsapp/service-window';
import { phoneNumberCandidates } from '../customers/phone-number';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRODUCT_CATALOGUE_IMAGE_URL = new URL('/ncut-product-catalogue.jpg', env.FRONTEND_URL).toString();
const WELCOME_IMAGE_URL = new URL('/ncut-welcome-message-v2.jpg', env.FRONTEND_URL).toString();
const PRODUCT_CATEGORY_TITLES: Record<string, string> = {
  'Velcro & PSA Backup Pads': 'Velcro & PSA Backup',
  'DC Wheel (Grinding Wheel)': 'DC Grinding Wheel',
};

function shortProductDescription(description: string): string {
  const normalized = description.trim().replace(/\s+/g, ' ');
  if (normalized.length <= 72) return normalized;
  const prefix = normalized.slice(0, 69);
  const wordBoundary = prefix.lastIndexOf(' ');
  return `${prefix.slice(0, wordBoundary > 0 ? wordBoundary : 69).trimEnd()}…`;
}

function firstCatalogueBody(category: string | undefined, productCount: number): string {
  if (productCount > 10) {
    return 'Here are the first 10 products from the catalogue. Select a product to view its photo and full description.';
  }
  return category
    ? `Browse ${category} products and select one to see its photo and full description.`
    : 'See the catalogue image above, then select a product to see its photo and full description.';
}

function remainingCatalogueBody(productCount: number): string {
  return `Here are the remaining ${productCount} ${productCount === 1 ? 'product' : 'products'} from the catalogue. Select a product to view its photo and full description.`;
}

type IncomingMessage = {
  id: string;
  from?: string;
  from_user_id?: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  image?: { id?: string; caption?: string };
  interactive?: {
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
};

type InteractiveButton = { id: string; title: string };
type InteractiveRow = { id: string; title: string; description?: string };
type InteractiveSection = { title: string; rows: InteractiveRow[] };
type DeliveryAction =
  | { type: 'WELCOME_OPTIONS'; body: string; buttons: InteractiveButton[] }
  | {
      type: 'PRODUCT_CATALOG';
      catalogId: string;
      header: string;
      body: string;
      sectionTitle: string;
      productIds: string[];
      remainingProductIds: string[];
    }
  | {
      type: 'PRODUCT_MENU';
      body: string;
      buttonText: string;
      sections: InteractiveSection[];
      content: Record<string, unknown>;
      remainingRows?: InteractiveRow[];
    }
  | { type: 'PRODUCT_DETAILS'; details: string; productId: string; uniqueProductCount: number; imageUrl?: string }
  | { type: 'PRODUCT_NEXT_STEPS'; uniqueProductCount: number }
  | { type: 'THIRD_PRODUCT_INTEREST' };

function isDeliveryAction(value: unknown): value is DeliveryAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'WELCOME_OPTIONS') return typeof record.body === 'string' && Array.isArray(record.buttons);
  if (record.type === 'PRODUCT_CATALOG') {
    return (
      typeof record.catalogId === 'string' &&
      typeof record.header === 'string' &&
      typeof record.body === 'string' &&
      typeof record.sectionTitle === 'string' &&
      Array.isArray(record.productIds) &&
      record.productIds.every((productId) => typeof productId === 'string') &&
      Array.isArray(record.remainingProductIds) &&
      record.remainingProductIds.every((productId) => typeof productId === 'string')
    );
  }
  if (record.type === 'PRODUCT_MENU') {
    return (
      typeof record.body === 'string' &&
      typeof record.buttonText === 'string' &&
      Array.isArray(record.sections) &&
      Boolean(record.content && typeof record.content === 'object' && !Array.isArray(record.content)) &&
      (record.remainingRows === undefined || Array.isArray(record.remainingRows))
    );
  }
  if (record.type === 'PRODUCT_DETAILS') {
    return (
      typeof record.details === 'string' &&
      typeof record.productId === 'string' &&
      typeof record.uniqueProductCount === 'number' &&
      (record.imageUrl === undefined || typeof record.imageUrl === 'string')
    );
  }
  return record.type === 'PRODUCT_NEXT_STEPS'
    ? typeof record.uniqueProductCount === 'number'
    : record.type === 'THIRD_PRODUCT_INTEREST';
}

function messageContent(message: IncomingMessage): Record<string, unknown> {
  if (message.text) return { text: message.text.body ?? '' };
  if (message.button) return { button: message.button };
  if (message.interactive?.button_reply) return { interactive: message.interactive.button_reply };
  if (message.interactive?.list_reply) return { interactive: message.interactive.list_reply };
  if (message.image) return { image: message.image };
  return { type: message.type };
}

async function findOrUpdateIncomingCustomer(
  message: IncomingMessage,
  customerIdentity: string,
  profileName?: string,
) {
  const phone = message.from?.replace(/\D/g, '');
  const phoneCandidates = phone ? phoneNumberCandidates(phone) : [];
  const phoneIdentities = phone
    ? [...new Set([phone, ...phoneCandidates.map((candidate) => candidate.replace(/\D/g, ''))])]
    : [];
  const matches = await Customer.find({
    $or: [
      { whatsappId: customerIdentity },
      ...(phoneIdentities.length ? [{ phoneIdentity: { $in: phoneIdentities } }] : []),
      ...(phoneCandidates.length
        ? [{ phoneNumber: { $in: phoneCandidates } }, { whatsappId: { $in: phoneCandidates } }]
        : []),
    ],
  }).sort({ createdAt: 1 });

  if (!matches.length) {
    const phoneIdentity = normalizePhoneIdentity(message.from ?? customerIdentity);
    const customer = await Customer.findOneAndUpdate(
      { whatsappId: customerIdentity },
      {
        $set: {
          ...(message.from ? { phoneNumber: message.from } : {}),
          ...(profileName ? { profileName } : {}),
          phoneIdentity,
        },
        $setOnInsert: { optInStatus: 'UNKNOWN' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (!customer) throw new Error('Unable to create or locate the WhatsApp customer');
    return customer;
  }

  const customerIds = matches.map((customer) => customer._id);
  const latestTemplateMessage = await Message.findOne({
    customerId: { $in: customerIds },
    direction: 'OUTBOUND',
    messageType: 'TEMPLATE',
  })
    .sort({ timestamp: -1 })
    .select('customerId')
    .lean();
  const latestOutboundMessage = latestTemplateMessage
    ? null
    : await Message.findOne({ customerId: { $in: customerIds }, direction: 'OUTBOUND' })
        .sort({ timestamp: -1 })
        .select('customerId')
        .lean();
  const outboundCustomerId = latestTemplateMessage?.customerId ?? latestOutboundMessage?.customerId;
  const activeConversation = outboundCustomerId
    ? null
    : await Conversation.findOne({
        customerId: { $in: customerIds },
        status: { $in: ['OPEN', 'HUMAN_HANDOVER'] },
      })
        .sort({ updatedAt: -1 })
        .select('customerId')
        .lean();
  const canonical =
    matches.find((candidate) => candidate._id.equals(outboundCustomerId ?? activeConversation?.customerId)) ??
    matches.find((candidate) => candidate.whatsappId === customerIdentity) ??
    matches.find((candidate) => candidate.optInStatus === 'OPTED_IN') ??
    matches[0]!;
  const duplicates = matches.filter((candidate) => !candidate._id.equals(canonical._id));
  const optedOutRecord = matches.find((candidate) => candidate.optInStatus === 'OPTED_OUT');
  const optedInRecord = matches.find((candidate) => candidate.optInStatus === 'OPTED_IN');

  if (!canonical.name) canonical.name = matches.find((candidate) => candidate.name)?.name;
  if (!profileName && !canonical.profileName) {
    canonical.profileName = matches.find((candidate) => candidate.profileName)?.profileName;
  }
  if (optedOutRecord) {
    canonical.optInStatus = 'OPTED_OUT';
    canonical.optInAt = undefined;
    canonical.optInSource = optedOutRecord.optInSource;
  } else if (canonical.optInStatus !== 'OPTED_IN' && optedInRecord) {
    canonical.optInStatus = 'OPTED_IN';
    canonical.optInAt = optedInRecord.optInAt;
    canonical.optInSource = optedInRecord.optInSource;
  }
  if (message.from) canonical.phoneNumber = message.from;
  if (profileName) canonical.profileName = profileName;
  canonical.phoneIdentity = normalizePhoneIdentity(message.from ?? customerIdentity);
  await canonical.save();

  if (duplicates.length) {
    const duplicateIds = duplicates.map((customer) => customer._id);
    await Conversation.updateMany(
      { customerId: { $in: duplicateIds }, status: { $in: ['OPEN', 'HUMAN_HANDOVER'] } },
      { $set: { status: 'CLOSED', currentStep: 'CLOSED' } },
    );
    await Promise.all([
      Conversation.updateMany({ customerId: { $in: duplicateIds } }, { $set: { customerId: canonical._id } }),
      Message.updateMany({ customerId: { $in: duplicateIds } }, { $set: { customerId: canonical._id } }),
      Lead.updateMany({ customerId: { $in: duplicateIds } }, { $set: { customerId: canonical._id } }),
      BulkCampaignRecipient.updateMany(
        { customerId: { $in: duplicateIds } },
        { $set: { customerId: canonical._id } },
      ),
    ]);
    await Customer.deleteMany({ _id: { $in: duplicateIds } });
  }

  canonical.whatsappId = customerIdentity;
  canonical.phoneIdentity = normalizePhoneIdentity(message.from ?? customerIdentity);
  await canonical.save();
  return canonical;
}

export class AutomationService {
  async processIncoming(message: IncomingMessage, profileName?: string): Promise<void> {
    const recipient = message.from ?? message.from_user_id;
    const customerIdentity = message.from_user_id ?? recipient;
    if (!recipient || !customerIdentity) throw new Error('Incoming WhatsApp message has no sender identity');
    const customer = await findOrUpdateIncomingCustomer(message, customerIdentity, profileName);
    const receivedAt = parseWhatsAppTimestamp(message.timestamp);
    let conversation = await Conversation.findOne({
      customerId: customer._id,
      status: { $in: ['OPEN', 'HUMAN_HANDOVER'] },
    }).sort({ updatedAt: -1 });
    if (!conversation) conversation = await Conversation.findOne({ customerId: customer._id }).sort({ updatedAt: -1 });
    if (conversation?.status === 'HUMAN_HANDOVER') {
      await this.saveInbound(message, customer._id, conversation._id, receivedAt);
      await this.notifyAdminOfInbound(message, customer, conversation._id);
      await Conversation.updateOne(
        { _id: conversation._id },
        { $max: { lastMessageAt: receivedAt, lastInteractionAt: receivedAt, lastInboundMessageAt: receivedAt } },
      );
      if (/^(stop|unsubscribe|opt out)$/i.test(message.text?.body?.trim() ?? '')) {
        customer.optInStatus = 'OPTED_OUT';
        await customer.save();
        return;
      }
      if (customer.optInStatus === 'OPTED_OUT') return;

      const handoverSelection = this.selection(message);
      if (handoverSelection?.id === 'go_home') {
        await Conversation.updateOne(
          { _id: conversation._id, status: 'HUMAN_HANDOVER' },
          {
            $set: { status: 'OPEN', currentStep: 'NEW', selectedProductIds: [], uniqueProductCount: 0 },
            $unset: {
              interestTriggeredAt: 1,
              interestPromptStatus: 1,
              interestPromptLockedAt: 1,
              currentCategory: 1,
              handoverAt: 1,
            },
          },
        );
        await this.sendWelcome(customer._id, conversation._id, recipient);
        return;
      }
      if (handoverSelection?.id === 'end_chat') {
        await Conversation.updateOne(
          { _id: conversation._id, status: 'HUMAN_HANDOVER' },
          { $set: { currentStep: 'FEEDBACK' } },
        );
        await this.sendFeedbackPrompt(customer._id, conversation._id, recipient);
        return;
      }
      if (
        conversation.currentStep === 'FEEDBACK' &&
        handoverSelection &&
        ['feedback_happy', 'feedback_neutral', 'feedback_unhappy'].includes(handoverSelection.id)
      ) {
        const feedback = handoverSelection.id === 'feedback_happy'
          ? 'HAPPY'
          : handoverSelection.id === 'feedback_neutral'
            ? 'NEUTRAL'
            : 'UNHAPPY';
        await this.recordLeadFeedback(customer, feedback);
        await this.sendTracked(customer._id, conversation._id, 'TEXT', { text: 'Thank you for your feedback!' }, () =>
          whatsappService.sendText(recipient, 'Thank you for your feedback!'),
        );
        await Conversation.updateOne(
          { _id: conversation._id },
          { $set: { status: 'CLOSED', currentStep: 'CLOSED' } },
        );
        return;
      }

      await Conversation.updateOne(
        { _id: conversation._id, status: 'HUMAN_HANDOVER' },
        {
          $set: { status: 'OPEN', currentStep: 'NEW', selectedProductIds: [], uniqueProductCount: 0 },
          $unset: {
            interestTriggeredAt: 1,
            interestPromptStatus: 1,
            interestPromptLockedAt: 1,
            currentCategory: 1,
            handoverAt: 1,
          },
        },
      );
      await this.sendWelcome(customer._id, conversation._id, recipient);
      return;
    }
    if (
      conversation?.status === 'OPEN' &&
      conversation.lastInteractionAt &&
      Date.now() - conversation.lastInteractionAt.getTime() > SESSION_TTL_MS
    ) {
      conversation.status = 'CLOSED';
      await conversation.save();
    }
    if (conversation?.status === 'CLOSED') {
      conversation = await Conversation.findOneAndUpdate(
        { _id: conversation._id, status: 'CLOSED' },
        {
          $set: { status: 'OPEN', currentStep: 'NEW', selectedProductIds: [], uniqueProductCount: 0 },
          $unset: {
            interestTriggeredAt: 1,
            interestPromptStatus: 1,
            interestPromptLockedAt: 1,
            currentCategory: 1,
            handoverAt: 1,
          },
        },
        { new: true, runValidators: true },
      );
    }
    if (!conversation) {
      conversation = await Conversation.findOneAndUpdate(
        { customerId: customer._id, status: 'OPEN' },
        { $setOnInsert: { customerId: customer._id, status: 'OPEN', currentStep: 'NEW' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }
    if (!conversation) throw new Error('Unable to create or locate an active conversation');

    await this.saveInbound(message, customer._id, conversation._id, receivedAt);
    await this.notifyAdminOfInbound(message, customer, conversation._id);
    await Conversation.updateOne(
      { _id: conversation._id },
      { $max: { lastMessageAt: receivedAt, lastInteractionAt: receivedAt, lastInboundMessageAt: receivedAt } },
    );

    const input = this.selection(message);
    const text = message.text?.body?.trim() ?? '';
    if (/^(stop|unsubscribe|opt out)$/i.test(text)) {
      customer.optInStatus = 'OPTED_OUT';
      await customer.save();
      return;
    }
    if (customer.optInStatus === 'OPTED_OUT') return;

    if (/^(restart|start over|menu)$/i.test(text) && conversation.currentStep !== 'NEW') {
      await Conversation.updateOne(
        { _id: conversation._id, status: 'OPEN' },
        {
          $set: { currentStep: 'NEW', selectedProductIds: [], uniqueProductCount: 0 },
          $unset: {
            interestTriggeredAt: 1,
            interestPromptStatus: 1,
            interestPromptLockedAt: 1,
            currentCategory: 1,
          },
        },
      );
      await this.sendWelcome(customer._id, conversation._id, recipient);
      return;
    }
    if (!input) {
      if (conversation.currentStep === 'NEW') {
        await this.sendWelcome(customer._id, conversation._id, recipient);
      } else if (conversation.currentStep === 'WELCOME_SENT') {
        await this.sendWelcome(customer._id, conversation._id, recipient);
      } else {
        const body = 'Choose an option to continue.';
        await this.sendTracked(customer._id, conversation._id, 'INTERACTIVE', { text: body }, () =>
          whatsappService.sendButtons(recipient, body, [
            { id: 'explore_products', title: 'Explore Products' },
            { id: 'connect_sales', title: 'Connect With Team' },
          ]),
        );
      }
      return;
    }
    await this.handleSelection(input.id, customer._id, conversation, recipient, message.id, receivedAt);
  }

  private selection(message: IncomingMessage): { id: string } | undefined {
    const selected = message.interactive?.button_reply ?? message.interactive?.list_reply;
    if (selected) return { id: selected.id };
    if (!message.button) return undefined;

    const aliases: Record<string, string> = {
      explore_products: 'explore_products',
      explore_our_products: 'explore_products',
      connect_sales: 'connect_sales',
      connect_with_team: 'connect_sales',
      connect_with_our_team: 'connect_sales',
      contact_sales: 'connect_sales',
    };
    const candidates = [message.button.payload, message.button.text].filter(
      (value): value is string => Boolean(value?.trim()),
    );
    for (const candidate of candidates) {
      const normalized = candidate.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const id = aliases[normalized];
      if (id) return { id };
    }
    return candidates[0] ? { id: candidates[0] } : undefined;
  }

  private async saveInbound(
    message: IncomingMessage,
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    timestamp: Date,
  ): Promise<void> {
    await Message.updateOne(
      { whatsappMessageId: message.id },
      {
        $setOnInsert: {
          customerId,
          conversationId,
          whatsappMessageId: message.id,
          direction: 'INBOUND',
          messageType: message.interactive || message.button
            ? 'INTERACTIVE'
            : ['TEXT', 'IMAGE', 'TEMPLATE'].includes(message.type.toUpperCase())
              ? message.type.toUpperCase()
              : 'UNKNOWN',
          content: messageContent(message),
          status: 'RECEIVED',
          timestamp,
        },
      },
      { upsert: true },
    );
  }

  private async notifyAdminOfInbound(
    message: IncomingMessage,
    customer: { _id: Types.ObjectId; profileName?: string | null; name?: string | null },
    conversationId: Types.ObjectId,
  ): Promise<void> {
    const storedMessage = await Message.findOne({ whatsappMessageId: message.id }).select('_id');
    if (!storedMessage) throw new Error('Unable to locate the stored inbound message for admin notification');

    const customerName = (customer.profileName || customer.name || 'Customer')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const reply = (
      message.text?.body ??
      message.image?.caption ??
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title ??
      message.button?.text ??
      `[${message.type.toLowerCase()} message]`
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
    const body = `Hello Admin,\n\nIncoming WhatsApp message\n${customerName}: ${reply || '[empty message]'}` +
      '\n\nOpen the notification to review the details in your Ncut dashboard.';
    const dashboardUrl = new URL('/conversations', env.FRONTEND_URL);
    dashboardUrl.searchParams.set('conversation', conversationId.toString());

    if (isWebPushConfigured()) {
      const pushClaim = await Message.findOneAndUpdate(
        { _id: storedMessage._id, webPushStatus: { $exists: false } },
        { $set: { webPushStatus: 'SENDING' } },
        { new: true },
      );
      if (pushClaim) {
        try {
          const result = await webPushService.notifyAdmins({
            title: 'NCUT Abrasives Admin Notification',
            body: `${customerName}: ${reply || '[empty message]'}`,
            url: dashboardUrl.toString(),
          });
          await Message.updateOne(
            { _id: pushClaim._id, webPushStatus: 'SENDING' },
            {
              $set: {
                webPushStatus:
                  result.accepted > 0 ? 'ACCEPTED' : result.attempted === 0 ? 'NO_SUBSCRIPTIONS' : 'FAILED',
              },
            },
          );
        } catch (error) {
          await Message.updateOne(
            { _id: pushClaim._id, webPushStatus: 'SENDING' },
            { $set: { webPushStatus: 'FAILED' } },
          );
          logger.error(
            { err: error, messageId: message.id },
            'Web Push admin notification failed',
          );
        }
      }
    }

    if (env.SALES_NOTIFICATION_PROVIDER === 'whatsapp') {
      const claimed = await Message.findOneAndUpdate(
        { _id: storedMessage._id, adminNotificationStatus: { $exists: false } },
        { $set: { adminNotificationStatus: 'SENDING' } },
        { new: true },
      );
      if (!claimed) return;
      try {
        const whatsappMessageId = await whatsappService.sendDirectNotification(
          env.ADMIN_WHATSAPP_NUMBER.replace(/^\+/, ''),
          'NCUT Abrasives Admin Notification',
          body,
          dashboardUrl.toString(),
        );
        await Message.updateOne(
          { _id: claimed._id, adminNotificationStatus: 'SENDING' },
          {
            $set: {
              adminNotificationStatus: 'ACCEPTED',
              adminNotificationMessageId: whatsappMessageId,
            },
          },
        );
      } catch (error) {
        await Message.updateOne(
          { _id: claimed._id, adminNotificationStatus: 'SENDING' },
          { $set: { adminNotificationStatus: 'FAILED' } },
        );
        throw error;
      }
    }
  }

  private async sendWelcome(customerId: Types.ObjectId, conversationId: Types.ObjectId, to: string): Promise<void> {
    const settings = await WorkspaceSettings.findOne({ key: 'workspace' }).select('welcomeMessage').lean();
    const body = settings?.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE;
    const buttons = [
      { id: 'explore_products', title: 'Explore Our Products' },
      { id: 'connect_sales', title: 'Connect With Team' },
    ];
    await this.sendTracked(
      customerId,
      conversationId,
      'INTERACTIVE',
      { text: body, imageUrl: WELCOME_IMAGE_URL, buttons },
      () => whatsappService.sendImageButtons(to, WELCOME_IMAGE_URL, body, buttons),
    );
    await Conversation.updateOne({ _id: conversationId }, { $set: { currentStep: 'WELCOME_SENT' } });
  }

  private async handleSelection(
    id: string,
    customerId: Types.ObjectId,
    conversation: { _id: Types.ObjectId; currentStep: string; selectedProductIds: Types.ObjectId[] },
    to: string,
    inboundMessageId: string,
    occurredAt: Date,
  ): Promise<void> {
    if (id === 'explore_products') {
      await this.sendProducts(undefined, customerId, conversation._id, to);
      return;
    }
    if (id.startsWith('category_page:')) {
      await this.sendCategories(customerId, conversation._id, to, Number(id.slice('category_page:'.length)) || 0);
      return;
    }
    if (id === 'connect_sales') {
      await this.handover(customerId, conversation._id, to, inboundMessageId, occurredAt);
      return;
    }
    if (id === 'go_home') {
      await Conversation.updateOne(
        { _id: conversation._id },
        {
          $set: { status: 'OPEN', currentStep: 'NEW', selectedProductIds: [], uniqueProductCount: 0 },
          $unset: {
            interestTriggeredAt: 1,
            interestPromptStatus: 1,
            interestPromptLockedAt: 1,
            currentCategory: 1,
            handoverAt: 1,
          },
        },
      );
      await this.sendWelcome(customerId, conversation._id, to);
      return;
    }
    if (id === 'end_chat') {
      await Conversation.updateOne(
        { _id: conversation._id },
        { $set: { status: 'HUMAN_HANDOVER', currentStep: 'FEEDBACK' } },
      );
      await this.sendFeedbackPrompt(customerId, conversation._id, to);
      return;
    }
    if (['feedback_happy', 'feedback_neutral', 'feedback_unhappy'].includes(id)) {
      const feedback = id === 'feedback_happy'
        ? 'HAPPY'
        : id === 'feedback_neutral'
          ? 'NEUTRAL'
          : 'UNHAPPY';
      const customer = await Customer.findById(customerId).select('phoneNumber whatsappId');
      if (customer) await this.recordLeadFeedback(customer, feedback);
      await this.sendTracked(customerId, conversation._id, 'TEXT', { text: 'Thank you for your feedback!' }, () =>
        whatsappService.sendText(to, 'Thank you for your feedback!'),
      );
      await Conversation.updateOne(
        { _id: conversation._id },
        { $set: { status: 'CLOSED', currentStep: 'CLOSED' } },
      );
      return;
    }
    if (id.startsWith('category:')) {
      const category = decodeURIComponent(id.slice('category:'.length));
      await this.sendProducts(category, customerId, conversation._id, to);
      return;
    }
    if (id.startsWith('product:')) {
      await this.sendProduct(id.slice('product:'.length), customerId, conversation, to);
      return;
    }
    if (id === 'another_product') {
      await this.sendProducts(undefined, customerId, conversation._id, to);
      return;
    }
    if (id === 'main_menu') {
      await Conversation.updateOne(
        { _id: conversation._id },
        {
          $set: { status: 'OPEN', currentStep: 'NEW', selectedProductIds: [], uniqueProductCount: 0 },
          $unset: {
            interestTriggeredAt: 1,
            interestPromptStatus: 1,
            interestPromptLockedAt: 1,
            currentCategory: 1,
          },
        },
      );
      await this.sendWelcome(customerId, conversation._id, to);
      return;
    }
    const body = 'Sorry, I could not match that selection. Please choose an option.';
    await this.sendTracked(customerId, conversation._id, 'INTERACTIVE', { text: body }, () =>
      whatsappService.sendButtons(to, body, [
        { id: 'explore_products', title: 'Explore Products' },
        { id: 'connect_sales', title: 'Connect With Team' },
      ]),
    );
  }

  private async sendCategories(
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    to: string,
    page = 0,
  ): Promise<void> {
    const allCategories = await Product.distinct('category', { isActive: true });
    const start = Math.max(0, page) * 9;
    const rows = allCategories.slice(start, start + 9).map((category) => ({
      id: `category:${encodeURIComponent(category)}`,
      title: (PRODUCT_CATEGORY_TITLES[category] ?? category).slice(0, 24),
    }));
    if (start + 9 < allCategories.length) rows.push({ id: `category_page:${page + 1}`, title: 'More Categories' });
    await Conversation.updateOne({ _id: conversationId }, { $set: { currentStep: 'PRODUCT_MENU' } });
    await this.sendTracked(
      customerId,
      conversationId,
      'INTERACTIVE',
      { text: 'Explore our abrasive and finishing product categories.', categories: rows },
      () =>
      whatsappService.sendList(to, 'Explore our abrasive and finishing product categories.', 'View categories', [
        { title: 'Product categories', rows },
      ]),
    );
  }

  private async sendProducts(
    category: string | undefined,
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    to: string,
  ): Promise<void> {
    const filter: Record<string, unknown> = { isActive: true };
    if (category) filter.category = new RegExp(`^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const products = await Product.find(filter)
      .select('name description category whatsappProductRetailerId')
      .sort({ category: 1, name: 1 })
      .lean();
    if (products.length === 0) {
      const body = category
        ? `There are currently no active products listed in ${category}.`
        : 'There are currently no active products in the catalogue.';
      await this.sendTracked(customerId, conversationId, 'TEXT', { text: body }, () =>
        whatsappService.sendText(to, body),
      );
      return;
    }
    const rows: Array<{ id: string; title: string; description?: string }> = products.map((product) => ({
      id: `product:${product._id}`,
      title: product.name.slice(0, 24),
      description: shortProductDescription(product.description),
    }));
    const body = firstCatalogueBody(category, products.length);
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: {
          currentStep: 'PRODUCT_MENU',
          ...(category ? { currentCategory: category } : {}),
        },
        ...(!category ? { $unset: { currentCategory: 1 } } : {}),
      },
    );
    const catalogId = env.WHATSAPP_CATALOG_ID;
    const mappedProducts = products.flatMap((product) => {
      const retailerId = product.whatsappProductRetailerId?.trim();
      return retailerId ? [{ product, retailerId }] : [];
    });
    const hasCatalogMapping = products.length <= 30 && mappedProducts.length === products.length;
    if (catalogId && hasCatalogMapping) {
      const sectionTitle = category
        ? (PRODUCT_CATEGORY_TITLES[category] ?? category).slice(0, 24)
        : 'Available products';
      const productItems = mappedProducts.map(({ retailerId }) => ({ product_retailer_id: retailerId }));
      const productIds = productItems.slice(0, 10).map(({ product_retailer_id }) => product_retailer_id);
      const remainingProductIds = productItems.slice(10).map(({ product_retailer_id }) => product_retailer_id);
      await this.sendTracked(
        customerId,
        conversationId,
        'IMAGE',
        { imageUrl: PRODUCT_CATALOGUE_IMAGE_URL },
        () => whatsappService.sendImage(to, PRODUCT_CATALOGUE_IMAGE_URL),
        {
          type: 'PRODUCT_CATALOG',
          catalogId,
          header: 'N-CUT Products',
          body,
          sectionTitle,
          productIds,
          remainingProductIds,
        },
      );
      return;
    }
    if (catalogId && !hasCatalogMapping) {
      logger.warn(
        {
          catalogId,
          productCount: products.length,
          unmappedProductCount: products.filter((product) => !product.whatsappProductRetailerId?.trim()).length,
        },
        'Meta catalog is configured but products are missing retailer IDs or exceed the multi-product limit; using legacy product lists',
      );
    }
    const title = category ? (PRODUCT_CATEGORY_TITLES[category] ?? category).slice(0, 24) : 'Available products';
    const firstRows = rows.slice(0, 10);
    const content = {
      text: body,
      ...(category ? { category } : {}),
      products: products.map(({ _id, name, category }) => ({ id: _id, name, category })),
    };
    await this.sendTracked(
      customerId,
      conversationId,
      'IMAGE',
      { imageUrl: PRODUCT_CATALOGUE_IMAGE_URL },
      () => whatsappService.sendImage(to, PRODUCT_CATALOGUE_IMAGE_URL),
      {
        type: 'PRODUCT_MENU',
        body,
        buttonText: 'View products',
        sections: [{ title, rows: firstRows }],
        content,
        remainingRows: rows.slice(10),
      },
    );
  }

  private async sendProduct(
    productId: string,
    customerId: Types.ObjectId,
    conversation: { _id: Types.ObjectId; selectedProductIds: Types.ObjectId[] },
    to: string,
  ): Promise<void> {
    if (!mongoose.isValidObjectId(productId)) {
      const body = 'That product selection is invalid. Please choose a product from the menu.';
      await this.sendTracked(customerId, conversation._id, 'TEXT', { text: body }, () =>
        whatsappService.sendText(to, body),
      );
      return;
    }
    const product = await Product.findOne({ _id: productId, isActive: true }).lean();
    if (!product) {
      const body = 'That product is no longer available. Please choose another product.';
      await this.sendTracked(customerId, conversation._id, 'TEXT', { text: body }, () =>
        whatsappService.sendText(to, body),
      );
      return;
    }

    const update = await Conversation.updateOne(
      { _id: conversation._id, selectedProductIds: { $ne: product._id } },
      {
        $addToSet: { selectedProductIds: product._id },
        $inc: { uniqueProductCount: 1 },
        $set: { currentStep: 'PRODUCT_DETAILS' },
      },
    );
    const updatedConversation = await Conversation.findById(conversation._id).select('uniqueProductCount');
    const description = product.description.trim();
    const specificationLines = Object.entries(product.specifications ?? []).flatMap(([key, value]) => {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return [];
      const normalizedValue = String(value).trim();
      return normalizedValue ? [`${key}: ${normalizedValue}`] : [];
    });
    const details = [
      product.name,
      description,
      ...(specificationLines.length ? [`Specifications:\n${specificationLines.join('\n')}`] : []),
      ...(product.sizes.length ? [`Sizes: ${product.sizes.join(', ')}`] : []),
      ...(product.grits.length ? [`Grits: ${product.grits.join(', ')}`] : []),
      ...(product.colours.length ? [`Colours: ${product.colours.join(', ')}`] : []),
      ...(product.backing.length ? [`Backing: ${product.backing.join(', ')}`] : []),
    ]
      .filter(Boolean)
      .join('\n\n');
    const imageUrl = typeof product.imageUrl === 'string' && product.imageUrl.trim()
      ? product.imageUrl.trim()
      : undefined;
    const uniqueProductCount =
      updatedConversation?.uniqueProductCount ?? conversation.selectedProductIds.length + Number(update.modifiedCount > 0);
    await this.sendProductDetails(
      customerId,
      conversation._id,
      to,
      details,
      productId,
      uniqueProductCount,
      imageUrl,
    );
    logger.debug({ productId, uniqueSelection: Boolean(update.modifiedCount) }, 'Product selection processed');
  }

  private async sendProductDetails(
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    to: string,
    details: string,
    productId: string,
    uniqueProductCount: number,
    imageUrl?: string,
  ): Promise<void> {
    let body = `${details}\n\nWhat would you like to do next?`;

    if (uniqueProductCount >= 3) {
      await Conversation.updateOne(
        { _id: conversationId, interestTriggeredAt: { $exists: false } },
        {
          $set: { interestTriggeredAt: new Date(), interestPromptStatus: 'SENT', currentStep: 'INTEREST_TRIGGERED' },
        },
      );
      body = `${details}\n\nThank you for exploring our products! Would you like to connect with our sales team?`;
    }

    const buttons: InteractiveButton[] = [
      { id: 'another_product', title: 'Explore Another' },
      { id: 'connect_sales', title: 'Connect With Team' },
    ];
    await this.sendTracked(
      customerId,
      conversationId,
      'INTERACTIVE',
      { text: body, productId, type: 'product-details-next-steps', ...(imageUrl ? { imageUrl } : {}) },
      () => imageUrl
        ? whatsappService.sendImageButtons(to, imageUrl, body, buttons)
        : whatsappService.sendButtons(to, body, buttons),
    );
  }

  private async sendProductMenuList(
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    to: string,
    action: Extract<DeliveryAction, { type: 'PRODUCT_MENU' }>,
  ): Promise<void> {
    const remainingRows = action.remainingRows ?? [];
    const nextRows = remainingRows.slice(0, 10);
    const followup: DeliveryAction | undefined = nextRows.length
      ? {
          ...action,
          body: remainingCatalogueBody(nextRows.length),
          sections: [{ title: action.sections[0]?.title ?? 'Available products', rows: nextRows }],
          remainingRows: remainingRows.slice(nextRows.length),
        }
      : undefined;

    await this.sendTracked(
      customerId,
      conversationId,
      'INTERACTIVE',
      action.content,
      () => whatsappService.sendList(to, action.body, action.buttonText, action.sections),
      followup,
    );
  }

  private async sendNextProductCatalogList(
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    to: string,
    action: Extract<DeliveryAction, { type: 'PRODUCT_CATALOG' }>,
  ): Promise<void> {
    const nextProductIds = action.productIds;
    const remainingProductIds = action.remainingProductIds;
    const content = {
      text: action.body,
      catalogId: action.catalogId,
      products: nextProductIds.map((retailerId) => ({ retailerId })),
    };
    const followup: DeliveryAction | undefined = remainingProductIds.length
      ? {
          ...action,
          body: remainingCatalogueBody(Math.min(10, remainingProductIds.length)),
          productIds: remainingProductIds.slice(0, 10),
          remainingProductIds: remainingProductIds.slice(10),
        }
      : undefined;

    await this.sendTracked(
      customerId,
      conversationId,
      'INTERACTIVE',
      content,
      () =>
        whatsappService.sendProductList(to, action.catalogId, action.header, action.body, [
          {
            title: action.sectionTitle,
            product_items: nextProductIds.map((product_retailer_id) => ({ product_retailer_id })),
          },
        ]),
      followup,
    );
  }

  private async sendProductNextSteps(
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    to: string,
    uniqueProductCount: number,
  ): Promise<void> {
    const nextBody = 'What would you like to do next?';
    let deliveryAction: DeliveryAction | undefined;
    if (uniqueProductCount >= 3) {
      await Conversation.updateOne(
        { _id: conversationId, interestTriggeredAt: { $exists: false } },
        {
          $set: { interestTriggeredAt: new Date(), interestPromptStatus: 'PENDING', currentStep: 'INTEREST_TRIGGERED' },
        },
      );
      const conversation = await Conversation.findById(conversationId).select('interestPromptStatus').lean();
      if (conversation?.interestPromptStatus !== 'SENT') deliveryAction = { type: 'THIRD_PRODUCT_INTEREST' };
    }

    await this.sendTracked(
      customerId,
      conversationId,
      'INTERACTIVE',
      { text: nextBody },
      () =>
        whatsappService.sendList(to, nextBody, 'Next steps', [
          {
            title: 'Continue',
            rows: [
              { id: 'another_product', title: 'Explore Another Product' },
              { id: 'connect_sales', title: 'Connect With Our Team' },
            ],
          },
        ]),
      deliveryAction,
    );
  }

  private async sendThirdProductInterest(
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    to: string,
  ): Promise<void> {
    const staleLock = new Date(Date.now() - 5 * 60 * 1000);
    const prompt = await Conversation.findOneAndUpdate(
      {
        _id: conversationId,
        $or: [
          { interestPromptStatus: 'PENDING' },
          { interestPromptStatus: 'SENDING', interestPromptLockedAt: { $lt: staleLock } },
        ],
      },
      { $set: { interestPromptStatus: 'SENDING', interestPromptLockedAt: new Date() } },
      { new: true },
    );
    if (!prompt) return;

    const body =
      'Thank you for exploring our products!\n\nWe would be happy to understand your requirements and help you select the right solution.\n\nWould you like to connect with our sales team?';
    try {
      await this.sendTracked(
        customerId,
        conversationId,
        'INTERACTIVE',
        { text: body, type: 'third-product-interest-trigger' },
        () => whatsappService.sendButtons(to, body, [{ id: 'connect_sales', title: 'Connect With Team' }]),
      );
      await Conversation.updateOne(
        { _id: conversationId, interestPromptStatus: 'SENDING' },
        { $set: { interestPromptStatus: 'SENT' }, $unset: { interestPromptLockedAt: 1 } },
      );
    } catch (error) {
      await Conversation.updateOne(
        { _id: conversationId, interestPromptStatus: 'SENDING' },
        { $set: { interestPromptStatus: 'PENDING' }, $unset: { interestPromptLockedAt: 1 } },
      );
      throw error;
    }
  }

  async continueAfterDelivery(whatsappMessageId: string): Promise<void> {
    const staleLock = new Date(Date.now() - 5 * 60 * 1000);
    const message = await Message.findOneAndUpdate(
      {
        whatsappMessageId,
        status: { $in: ['DELIVERED', 'READ'] },
        $or: [
          { deliveryActionStatus: 'PENDING' },
          { deliveryActionStatus: 'SENDING', deliveryActionLockedAt: { $lt: staleLock } },
        ],
      },
      { $set: { deliveryActionStatus: 'SENDING', deliveryActionLockedAt: new Date() } },
      { new: true },
    );
    if (!message) return;

    if (!isDeliveryAction(message.deliveryAction)) {
      await Message.updateOne(
        { _id: message._id, deliveryActionStatus: 'SENDING' },
        { $set: { deliveryActionStatus: 'FAILED' }, $unset: { deliveryActionLockedAt: 1 } },
      );
      throw new Error(`Invalid delivery action for WhatsApp message ${whatsappMessageId}`);
    }

    try {
      const customer = await Customer.findById(message.customerId).select('phoneNumber whatsappId');
      const to = customer?.phoneNumber || customer?.whatsappId;
      if (!customer || !to) throw new Error(`Cannot resolve recipient for WhatsApp message ${whatsappMessageId}`);
      const conversation = await Conversation.findById(message.conversationId).select('status').lean();
      if (conversation?.status !== 'OPEN') {
        await Message.updateOne(
          { _id: message._id, deliveryActionStatus: 'SENDING' },
          {
            $set: { deliveryActionStatus: 'SENT' },
            $unset: { deliveryAction: 1, deliveryActionLockedAt: 1 },
          },
        );
        return;
      }

      const action = message.deliveryAction;
      if (action.type === 'WELCOME_OPTIONS') {
        await this.sendTracked(message.customerId, message.conversationId, 'INTERACTIVE', {
          text: action.body,
          buttons: action.buttons,
        }, () => whatsappService.sendButtons(to, action.body, action.buttons));
      } else if (action.type === 'PRODUCT_MENU') {
        await this.sendProductMenuList(message.customerId, message.conversationId, to, action);
      } else if (action.type === 'PRODUCT_CATALOG') {
        await this.sendNextProductCatalogList(message.customerId, message.conversationId, to, action);
      } else if (action.type === 'PRODUCT_DETAILS') {
        await this.sendProductDetails(
          message.customerId,
          message.conversationId,
          to,
          action.details,
          action.productId,
          action.uniqueProductCount,
          action.imageUrl,
        );
      } else if (action.type === 'PRODUCT_NEXT_STEPS') {
        await this.sendProductNextSteps(
          message.customerId,
          message.conversationId,
          to,
          action.uniqueProductCount,
        );
      } else {
        await this.sendThirdProductInterest(message.customerId, message.conversationId, to);
      }

      await Message.updateOne(
        { _id: message._id, deliveryActionStatus: 'SENDING' },
        {
          $set: { deliveryActionStatus: 'SENT' },
          $unset: { deliveryAction: 1, deliveryActionLockedAt: 1 },
        },
      );
    } catch (error) {
      await Message.updateOne(
        { _id: message._id, deliveryActionStatus: 'SENDING' },
        { $set: { deliveryActionStatus: 'PENDING' }, $unset: { deliveryActionLockedAt: 1 } },
      );
      throw error;
    }
  }

  private async handover(
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    to: string,
    inboundMessageId: string,
    occurredAt: Date,
  ): Promise<void> {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) return;
    if (conversation.status !== 'HUMAN_HANDOVER') {
      conversation.status = 'HUMAN_HANDOVER';
      conversation.currentStep = 'HUMAN_HANDOVER';
      conversation.handoverAt = new Date();
      await conversation.save();
    }
    const customer = await Customer.findById(customerId).select('phoneNumber whatsappId');
    if (!customer) throw new Error('Unable to locate the customer for sales handover');
    const phoneIdentity = normalizePhoneIdentity(customer.phoneNumber || customer.whatsappId);
    const customerIds = phoneIdentity
      ? await Customer.find({ phoneIdentity }).distinct('_id')
      : [customer._id];
    let lead = await Lead.findOne({ customerId: { $in: customerIds } }).sort({ updatedAt: -1 });
    if (lead) {
      lead = await Lead.findOneAndUpdate(
        { _id: lead._id },
        {
          $addToSet: {
            conversationHistory: conversationId,
            selectedProducts: { $each: conversation.selectedProductIds },
            visitHistory: {
              whatsappMessageId: inboundMessageId,
              conversationId,
              occurredAt,
            },
          },
          $set: { requirement: lead.requirement?.trim() || SALES_FOLLOW_UP_REQUIREMENT },
          $unset: { adminReadAt: 1 },
        },
        { new: true },
      );
    } else {
      lead = await Lead.findOneAndUpdate(
        { conversationId },
        {
          $setOnInsert: {
            customerId,
            conversationId,
            conversationHistory: [conversationId],
            visitHistory: [{ whatsappMessageId: inboundMessageId, conversationId, occurredAt }],
            selectedProducts: conversation.selectedProductIds,
            requirement: SALES_FOLLOW_UP_REQUIREMENT,
            status: 'NEW',
          },
        },
        { upsert: true, new: true },
      );
    }
    if (!lead) throw new Error('Unable to create or locate the customer lead');
    if (env.SALES_NOTIFICATION_PROVIDER !== 'whatsapp' && lead.notificationStatus !== 'SENT') {
      const notifyBody = JSON.stringify({
        event: 'lead.created',
        leadId: lead.id,
        customerId: customerId.toString(),
        conversationId: conversationId.toString(),
        phoneNumber: to,
        selectedProductIds: conversation.selectedProductIds.map((productId) => productId.toString()),
      });
      if (env.SALES_NOTIFICATION_PROVIDER === 'webhook') {
        if (!env.SALES_NOTIFICATION_TARGET)
          throw new Error('SALES_NOTIFICATION_TARGET is required for webhook notifications');
        const response = await fetch(env.SALES_NOTIFICATION_TARGET, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `lead:${lead.id}` },
          signal: AbortSignal.timeout(10_000),
          body: notifyBody,
        });
        if (!response.ok) throw new Error(`Sales notification failed with HTTP ${response.status}`);
      } else {
        logger.info({ leadId: lead.id }, 'Sales lead created');
      }
      await Lead.updateOne({ _id: lead._id }, { $set: { notificationStatus: 'SENT', notificationSentAt: new Date() } });
    } else if (env.SALES_NOTIFICATION_PROVIDER === 'whatsapp') {
      const inboundNotification = await Message.findOne({ whatsappMessageId: inboundMessageId })
        .select('adminNotificationStatus adminNotificationMessageId')
        .lean();
      if (inboundNotification?.adminNotificationStatus === 'ACCEPTED' && inboundNotification.adminNotificationMessageId) {
        await Lead.updateOne(
          { _id: lead._id },
          {
            $set: {
              notificationStatus: 'ACCEPTED',
              notificationSentAt: new Date(),
              notificationMessageId: inboundNotification.adminNotificationMessageId,
            },
          },
        );
      }
    }
    const body = 'Thank you. A member of our sales team will be in touch with you.\n\nIs there anything else you\'d like me to help you with?';
    await this.sendTracked(customerId, conversationId, 'INTERACTIVE', {
      text: body,
      buttons: [{ id: 'go_home', title: 'Go Home' }, { id: 'end_chat', title: 'End Chat' }],
    }, () =>
      whatsappService.sendButtons(to, body, [
        { id: 'go_home', title: 'Go Home' },
        { id: 'end_chat', title: 'End Chat' },
      ]),
    );
  }

  private async sendFeedbackPrompt(customerId: Types.ObjectId, conversationId: Types.ObjectId, to: string): Promise<void> {
    const body = 'Tell me how it felt. Just tap a rating below';
    await this.sendTracked(customerId, conversationId, 'INTERACTIVE', {
      text: body,
      buttons: [
        { id: 'feedback_happy', title: 'Happy 😄' },
        { id: 'feedback_neutral', title: 'Neutral 😐' },
        { id: 'feedback_unhappy', title: 'Unhappy 😞' },
      ],
    }, () =>
      whatsappService.sendButtons(to, body, [
        { id: 'feedback_happy', title: 'Happy 😄' },
        { id: 'feedback_neutral', title: 'Neutral 😐' },
        { id: 'feedback_unhappy', title: 'Unhappy 😞' },
      ]),
    );
  }

  private async recordLeadFeedback(
    customer: { _id: Types.ObjectId; phoneNumber?: string | null; whatsappId: string },
    feedback: 'HAPPY' | 'NEUTRAL' | 'UNHAPPY',
  ): Promise<void> {
    const phoneIdentity = normalizePhoneIdentity(customer.phoneNumber || customer.whatsappId);
    const customerIds = phoneIdentity
      ? await Customer.find({ phoneIdentity }).distinct('_id')
      : [customer._id];
    const lead = await Lead.findOne({ customerId: { $in: customerIds } }).sort({ updatedAt: -1 });
    if (lead) {
      await Lead.updateOne(
        { _id: lead._id },
        { $set: { feedback, feedbackAt: new Date() } },
      );
    }
  }

  private async sendTracked(
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    messageType: 'TEXT' | 'IMAGE' | 'INTERACTIVE' | 'TEMPLATE',
    content: Record<string, unknown>,
    send: () => Promise<string>,
    deliveryAction?: DeliveryAction,
  ): Promise<void> {
    const whatsappMessageId = await send();
    await Message.create({
      customerId,
      conversationId,
      whatsappMessageId,
      direction: 'OUTBOUND',
      messageType,
      content,
      status: 'SENT',
      ...(deliveryAction ? { deliveryAction, deliveryActionStatus: 'PENDING' } : {}),
      timestamp: new Date(),
    });
  }
}

export const automationService = new AutomationService();
