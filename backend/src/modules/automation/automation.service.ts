import mongoose, { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { Conversation } from '../../database/models/conversation.model';
import { Customer, normalizePhoneIdentity } from '../../database/models/customer.model';
import { Lead } from '../../database/models/lead.model';
import { Message } from '../../database/models/message.model';
import { Product } from '../../database/models/product.model';
import { DEFAULT_WELCOME_MESSAGE, WorkspaceSettings } from '../../database/models/workspace-settings.model';
import { whatsappService } from '../whatsapp/whatsapp.service';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRODUCT_CATALOGUE_IMAGE_URL = new URL(
  '/N-CUT%20Abrasives%20Product%20Catalogue%20.png',
  env.FRONTEND_URL,
).toString();
const PRODUCT_CATEGORY_TITLES: Record<string, string> = {
  'Velcro & PSA Backup Pads': 'Velcro & PSA Backup',
  'DC Wheel (Grinding Wheel)': 'DC Grinding Wheel',
};

type IncomingMessage = {
  id: string;
  from?: string;
  from_user_id?: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string };
  interactive?: {
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
};

function messageContent(message: IncomingMessage): Record<string, unknown> {
  if (message.text) return { text: message.text.body ?? '' };
  if (message.interactive?.button_reply) return { interactive: message.interactive.button_reply };
  if (message.interactive?.list_reply) return { interactive: message.interactive.list_reply };
  if (message.image) return { image: message.image };
  return { type: message.type };
}

export class AutomationService {
  async processIncoming(message: IncomingMessage, profileName?: string): Promise<void> {
    const recipient = message.from ?? message.from_user_id;
    const customerIdentity = message.from_user_id ?? recipient;
    if (!recipient || !customerIdentity) throw new Error('Incoming WhatsApp message has no sender identity');
    const customer = await Customer.findOneAndUpdate(
      { whatsappId: customerIdentity },
      {
        $set: {
          ...(message.from ? { phoneNumber: message.from } : {}),
          ...(profileName ? { profileName } : {}),
          phoneIdentity: normalizePhoneIdentity(message.from ?? customerIdentity),
        },
        $setOnInsert: { optInStatus: 'UNKNOWN' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const receivedAt = new Date(Number(message.timestamp) * 1000);
    let conversation = await Conversation.findOne({
      customerId: customer._id,
      status: { $in: ['OPEN', 'HUMAN_HANDOVER'] },
    }).sort({ updatedAt: -1 });
    if (!conversation) conversation = await Conversation.findOne({ customerId: customer._id }).sort({ updatedAt: -1 });
    if (conversation?.status === 'HUMAN_HANDOVER') {
      await this.saveInbound(message, customer._id, conversation._id, receivedAt);
      conversation.lastMessageAt = receivedAt;
      conversation.lastInteractionAt = receivedAt;
      await conversation.save();
      if (/^(stop|unsubscribe|opt out)$/i.test(message.text?.body?.trim() ?? '')) {
        customer.optInStatus = 'OPTED_OUT';
        await customer.save();
        return;
      }
      if (this.selection(message)?.id === 'connect_sales') {
        await this.handover(customer._id, conversation._id, recipient, message.id, receivedAt);
      }
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
    conversation.lastMessageAt = receivedAt;
    conversation.lastInteractionAt = receivedAt;
    await conversation.save();

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
    return selected ? { id: selected.id } : undefined;
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
          messageType: message.interactive
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

  private async sendWelcome(customerId: Types.ObjectId, conversationId: Types.ObjectId, to: string): Promise<void> {
    const settings = await WorkspaceSettings.findOne({ key: 'workspace' }).select('welcomeMessage').lean();
    const body = settings?.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE;
    await this.sendTracked(customerId, conversationId, 'INTERACTIVE', { text: body }, () =>
      whatsappService.sendButtons(to, body, [
        { id: 'explore_products', title: 'Explore Our Products' },
        { id: 'connect_sales', title: 'Connect With Team' },
      ]),
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
      await this.sendProducts(undefined, customerId, conversation._id, to, 0);
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
    if (id.startsWith('category:')) {
      const category = decodeURIComponent(id.slice('category:'.length));
      await this.sendProducts(category, customerId, conversation._id, to, 0);
      return;
    }
    if (id.startsWith('product_page:')) {
      const parts = id.split(':');
      const page = Number(parts.at(-1)) || 0;
      const category = parts.length > 2 ? decodeURIComponent(parts.slice(1, -1).join(':')) : undefined;
      await this.sendProducts(category, customerId, conversation._id, to, page);
      return;
    }
    if (id.startsWith('product:')) {
      await this.sendProduct(id.slice('product:'.length), customerId, conversation, to);
      return;
    }
    if (id === 'another_product') {
      await this.sendProducts(undefined, customerId, conversation._id, to, 0);
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
    page: number,
  ): Promise<void> {
    const filter: Record<string, unknown> = { isActive: true };
    if (category) filter.category = new RegExp(`^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const products = await Product.find(filter)
      .select('name description category')
      .sort({ category: 1, name: 1 })
      .skip(Math.max(0, page) * 9)
      .limit(10)
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
    const rows: Array<{ id: string; title: string; description?: string }> = products.slice(0, 9).map((product) => ({
      id: `product:${product._id}`,
      title: product.name.slice(0, 24),
      description: `${product.category} · ${product.description}`.slice(0, 72),
    }));
    if (products.length > 9)
      rows.push({
        id: category
          ? `product_page:${encodeURIComponent(category)}:${page + 1}`
          : `product_page:${page + 1}`,
        title: 'More Products',
      });
    const body = category
      ? `Select a ${category} product below to receive its photo, description, and specifications.`
      : 'See the catalogue image above, then choose a product below to receive its photo, description, and specifications.';
    await Conversation.updateOne({ _id: conversationId }, { $set: { currentStep: 'PRODUCT_MENU' } });
    if (page === 0) {
      await this.sendTracked(customerId, conversationId, 'IMAGE', { imageUrl: PRODUCT_CATALOGUE_IMAGE_URL }, () =>
        whatsappService.sendImage(to, PRODUCT_CATALOGUE_IMAGE_URL),
      );
    }
    await this.sendTracked(
      customerId,
      conversationId,
      'INTERACTIVE',
      {
        text: body,
        ...(category ? { category } : {}),
        products: products.map(({ _id, name, category }) => ({ id: _id, name, category })),
      },
      () =>
        whatsappService.sendList(to, body, 'View products', [
          { title: category ? (PRODUCT_CATEGORY_TITLES[category] ?? category).slice(0, 24) : 'Available products', rows },
        ]),
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
    const specificationLines = Object.entries(product.specifications ?? {}).map(
      ([key, value]) => `${key}: ${String(value)}`,
    );
    const details = [
      product.name,
      product.description,
      ...(specificationLines.length ? [`Specifications:\n${specificationLines.join('\n')}`] : []),
      ...(product.sizes.length ? [`Sizes: ${product.sizes.join(', ')}`] : []),
      ...(product.grits.length ? [`Grits: ${product.grits.join(', ')}`] : []),
      ...(product.colours.length ? [`Colours: ${product.colours.join(', ')}`] : []),
      ...(product.backing.length ? [`Backing: ${product.backing.join(', ')}`] : []),
    ].join('\n\n');
    const imageUrl = product.imageUrl;
    if (imageUrl) {
      await this.sendTracked(
        customerId,
        conversation._id,
        'IMAGE',
        { imageUrl: product.imageUrl, caption: product.name },
        () => whatsappService.sendImage(to, imageUrl, product.name),
      );
    }
    await this.sendTracked(customerId, conversation._id, 'TEXT', { text: details, productId: product._id }, () =>
      whatsappService.sendText(to, details),
    );
    const nextBody = 'What would you like to do next?';
    await this.sendTracked(customerId, conversation._id, 'INTERACTIVE', { text: nextBody }, () =>
      whatsappService.sendList(to, nextBody, 'Next steps', [
        {
          title: 'Continue',
          rows: [
            { id: 'another_product', title: 'Explore Another Product' },
            { id: 'connect_sales', title: 'Connect With Our Team' },
          ],
        },
      ]),
    );

    if (updatedConversation && updatedConversation.uniqueProductCount >= 3) {
      await Conversation.updateOne(
        { _id: conversation._id, interestTriggeredAt: { $exists: false } },
        {
          $set: { interestTriggeredAt: new Date(), interestPromptStatus: 'PENDING', currentStep: 'INTEREST_TRIGGERED' },
        },
      );
      const staleLock = new Date(Date.now() - 5 * 60 * 1000);
      const prompt = await Conversation.findOneAndUpdate(
        {
          _id: conversation._id,
          $or: [
            { interestPromptStatus: 'PENDING' },
            { interestPromptStatus: 'SENDING', interestPromptLockedAt: { $lt: staleLock } },
          ],
        },
        { $set: { interestPromptStatus: 'SENDING', interestPromptLockedAt: new Date() } },
        { new: true },
      );
      if (prompt) {
        const body =
          'Thank you for exploring our products!\n\nWe would be happy to understand your requirements and help you select the right solution.\n\nWould you like to connect with our sales team?';
        try {
          await this.sendTracked(
            customerId,
            conversation._id,
            'INTERACTIVE',
            { text: body, type: 'third-product-interest-trigger' },
            () => whatsappService.sendButtons(to, body, [{ id: 'connect_sales', title: 'Connect With Team' }]),
          );
          await Conversation.updateOne(
            { _id: conversation._id, interestPromptStatus: 'SENDING' },
            { $set: { interestPromptStatus: 'SENT' }, $unset: { interestPromptLockedAt: 1 } },
          );
        } catch (error) {
          await Conversation.updateOne(
            { _id: conversation._id, interestPromptStatus: 'SENDING' },
            { $set: { interestPromptStatus: 'PENDING' }, $unset: { interestPromptLockedAt: 1 } },
          );
          throw error;
        }
      }
    }
    logger.debug({ productId, uniqueSelection: Boolean(update.modifiedCount) }, 'Product selection processed');
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
            status: 'NEW',
          },
        },
        { upsert: true, new: true },
      );
    }
    if (!lead) throw new Error('Unable to create or locate the customer lead');
    if (lead.notificationStatus !== 'SENT') {
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
    }
    await this.sendTracked(customerId, conversationId, 'TEXT', { text: 'Sales handover confirmed.' }, () =>
      whatsappService.sendText(to, 'Thank you. A member of our sales team will be in touch with you.'),
    );
  }

  private async sendTracked(
    customerId: Types.ObjectId,
    conversationId: Types.ObjectId,
    messageType: 'TEXT' | 'IMAGE' | 'INTERACTIVE' | 'TEMPLATE',
    content: Record<string, unknown>,
    send: () => Promise<string>,
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
      timestamp: new Date(),
    });
  }
}

export const automationService = new AutomationService();
