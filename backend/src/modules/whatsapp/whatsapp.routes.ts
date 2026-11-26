import { Router } from 'express';
import { z } from 'zod';
import { Conversation } from '../../database/models/conversation.model';
import { Customer } from '../../database/models/customer.model';
import { Message } from '../../database/models/message.model';
import { MessageTemplate } from '../../database/models/message-template.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';
import { whatsappService } from './whatsapp.service';
import { isServiceWindowOpen } from './service-window';

const sendBase = z.object({ customerId: z.string().regex(/^[a-f\d]{24}$/i) });
export const whatsappRouter = Router();

async function getMessagingContext(customerId: string) {
  const [customer, conversation] = await Promise.all([
    Customer.findById(customerId),
    Conversation.findOne({ customerId, status: { $in: ['OPEN', 'HUMAN_HANDOVER'] } }).sort({ updatedAt: -1 }),
  ]);
  if (!customer || !conversation) throw new ApiError(404, 'Active customer conversation not found', 'NOT_FOUND');
  if (customer.optInStatus === 'OPTED_OUT')
    throw new ApiError(409, 'Customer has opted out of messages', 'CUSTOMER_OPTED_OUT');
  if (!isServiceWindowOpen(conversation.lastInboundMessageAt)) {
    throw new ApiError(
      409,
      'The 24-hour service window has expired; send an approved template instead',
      'SERVICE_WINDOW_EXPIRED',
    );
  }
  return { customer, conversation };
}

whatsappRouter.post(
  '/send-message',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const input = sendBase.extend({ message: z.string().trim().min(1).max(4096) }).parse(req.body);
    const { customer, conversation } = await getMessagingContext(input.customerId);
    const whatsappMessageId = await whatsappService.sendText(
      customer.phoneNumber ?? customer.whatsappId,
      input.message,
    );
    const message = await Message.create({
      customerId: customer._id,
      conversationId: conversation._id,
      whatsappMessageId,
      direction: 'OUTBOUND',
      messageType: 'TEXT',
      content: { text: input.message },
      status: 'SENT',
      timestamp: new Date(),
    });
    res.status(201).json({ success: true, data: message });
  }),
);

whatsappRouter.post(
  '/send-template',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const input = sendBase
      .extend({
        templateId: z.string().regex(/^[a-f\d]{24}$/i),
        components: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .parse(req.body);
    const [customer, conversation, template] = await Promise.all([
      Customer.findById(input.customerId),
      Conversation.findOne({ customerId: input.customerId, status: { $in: ['OPEN', 'HUMAN_HANDOVER'] } }).sort({
        updatedAt: -1,
      }),
      MessageTemplate.findOne({ _id: input.templateId, metaStatus: 'APPROVED' }),
    ]);
    if (!customer || !conversation || !template)
      throw new ApiError(404, 'Customer conversation or approved template not found', 'NOT_FOUND');
    if (customer.optInStatus !== 'OPTED_IN')
      throw new ApiError(
        409,
        'Customer opt-in is required for business-initiated messages',
        'CUSTOMER_OPT_IN_REQUIRED',
      );
    const whatsappMessageId = await whatsappService.sendTemplate(
      customer.phoneNumber ?? customer.whatsappId,
      template.name,
      template.languageCode,
      input.components ?? template.defaultSendComponents,
    );
    const message = await Message.create({
      customerId: customer._id,
      conversationId: conversation._id,
      whatsappMessageId,
      direction: 'OUTBOUND',
      messageType: 'TEMPLATE',
      content: { templateName: template.name, languageCode: template.languageCode },
      status: 'SENT',
      timestamp: new Date(),
    });
    res.status(201).json({ success: true, data: message });
  }),
);

whatsappRouter.post(
  '/send-image',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const input = sendBase
      .extend({ imageUrl: z.string().url(), caption: z.string().max(1024).optional() })
      .parse(req.body);
    const { customer, conversation } = await getMessagingContext(input.customerId);
    const whatsappMessageId = await whatsappService.sendImage(
      customer.phoneNumber ?? customer.whatsappId,
      input.imageUrl,
      input.caption,
    );
    const message = await Message.create({
      customerId: customer._id,
      conversationId: conversation._id,
      whatsappMessageId,
      direction: 'OUTBOUND',
      messageType: 'IMAGE',
      content: { imageUrl: input.imageUrl, caption: input.caption },
      status: 'SENT',
      timestamp: new Date(),
    });
    res.status(201).json({ success: true, data: message });
  }),
);

whatsappRouter.post(
  '/send-interactive',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const input = sendBase
      .extend({
        body: z.string().trim().min(1).max(1024),
        buttons: z.array(
          z.object({ id: z.string().trim().min(1).max(256), title: z.string().trim().min(1).max(20) }),
        ).min(1).max(3),
      })
      .parse(req.body);
    const { customer, conversation } = await getMessagingContext(input.customerId);
    const whatsappMessageId = await whatsappService.sendButtons(
      customer.phoneNumber ?? customer.whatsappId,
      input.body,
      input.buttons,
    );
    const message = await Message.create({
      customerId: customer._id,
      conversationId: conversation._id,
      whatsappMessageId,
      direction: 'OUTBOUND',
      messageType: 'INTERACTIVE',
      content: { text: input.body, buttons: input.buttons },
      status: 'SENT',
      timestamp: new Date(),
    });
    res.status(201).json({ success: true, data: message });
  }),
);
