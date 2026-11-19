import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Conversation } from '../../database/models/conversation.model';
import { Message } from '../../database/models/message.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';
import { whatsappService } from '../whatsapp/whatsapp.service';

export const conversationsRouter = Router();

conversationsRouter.post(
  '/:id/resume-automation',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const conversation = await Conversation.findOneAndUpdate(
      { _id: req.params.id, status: 'HUMAN_HANDOVER' },
      {
        $set: {
          status: 'OPEN',
          currentStep: 'NEW',
          selectedProductIds: [],
          uniqueProductCount: 0,
        },
        $unset: {
          interestTriggeredAt: 1,
          interestPromptStatus: 1,
          interestPromptLockedAt: 1,
          currentCategory: 1,
        },
      },
      { new: true, runValidators: true },
    );
    if (!conversation) {
      const exists = await Conversation.exists({ _id: req.params.id });
      if (!exists) throw new ApiError(404, 'Conversation not found', 'NOT_FOUND');
      throw new ApiError(409, 'Automation can only be resumed from a sales handover', 'INVALID_CONVERSATION_STATUS');
    }
    res.json({ success: true, data: conversation });
  }),
);

conversationsRouter.patch(
  '/:id/status',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(['CLOSED']) }).parse(req.body);
    const conversation = await Conversation.findByIdAndUpdate(
      req.params.id,
      { $set: { status, currentStep: status } },
      { new: true, runValidators: true },
    );
    if (!conversation) throw new ApiError(404, 'Conversation not found', 'NOT_FOUND');
    res.json({ success: true, data: conversation });
  }),
);

conversationsRouter.get(
  '/',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter: Record<string, unknown> = {};
    if (typeof req.query.status === 'string') filter.status = req.query.status;
    const [result] = await Conversation.aggregate([
      { $match: filter },
      {
        $addFields: {
          activePriority: {
            $cond: [{ $in: ['$status', ['OPEN', 'HUMAN_HANDOVER']] }, 1, 0],
          },
        },
      },
      { $sort: { customerId: 1, activePriority: -1, updatedAt: -1, lastMessageAt: -1 } },
      { $group: { _id: '$customerId', conversation: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$conversation' } },
      { $sort: { lastMessageAt: -1, updatedAt: -1 } },
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          total: [{ $count: 'count' }],
        },
      },
    ]);
    const selected = (result?.items ?? []) as Array<{ _id: Types.ObjectId; customerId: Types.ObjectId }>;
    const conversationIds = selected.map((item) => item._id);
    const customerIds = selected.map((item) => item.customerId);
    const customerBySelectedConversation = new Map(
      selected.map((item) => [item._id.toString(), item.customerId.toString()]),
    );
    const [populatedItems, relatedConversations] = await Promise.all([
      Conversation.find({ _id: { $in: conversationIds } })
        .populate('customerId', 'profileName name phoneNumber whatsappId')
        .lean(),
      Conversation.find({ customerId: { $in: customerIds } })
        .select('_id customerId')
        .lean(),
    ]);
    const itemById = new Map(populatedItems.map((item) => [item._id.toString(), item]));
    const orderedItems = conversationIds
      .map((id) => itemById.get(id.toString()))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const customerByConversation = new Map(
      relatedConversations.map((item) => [item._id.toString(), item.customerId.toString()]),
    );
    const unreadCounts = await Message.aggregate<{ _id: Types.ObjectId; count: number }>([
      {
        $match: {
          conversationId: { $in: relatedConversations.map((item) => item._id) },
          direction: 'INBOUND',
          status: 'RECEIVED',
        },
      },
      { $group: { _id: '$conversationId', count: { $sum: 1 } } },
    ]);
    const unreadByCustomer = new Map<string, number>();
    for (const { _id, count } of unreadCounts) {
      const customerId = customerByConversation.get(_id.toString());
      if (customerId) unreadByCustomer.set(customerId, (unreadByCustomer.get(customerId) ?? 0) + count);
    }
    res.json({
      success: true,
      data: {
        items: orderedItems.map((item) => ({
          ...item,
          unreadCount: unreadByCustomer.get(customerBySelectedConversation.get(item._id.toString()) ?? '') ?? 0,
        })),
        page,
        limit,
        total: result?.total?.[0]?.count ?? 0,
      },
    });
  }),
);

conversationsRouter.post(
  '/:id/read',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const conversation = await Conversation.findById(req.params.id).select('customerId').lean();
    if (!conversation) throw new ApiError(404, 'Conversation not found', 'NOT_FOUND');
    const conversationIds = await Conversation.distinct('_id', { customerId: conversation.customerId });

    const unreadMessages = await Message.find({
      conversationId: { $in: conversationIds },
      direction: 'INBOUND',
      status: 'RECEIVED',
    })
      .sort({ timestamp: -1 })
      .limit(100)
      .select('whatsappMessageId timestamp')
      .lean();
    const latestUnread = unreadMessages[0];
    if (latestUnread?.whatsappMessageId) await whatsappService.markRead(latestUnread.whatsappMessageId);
    if (latestUnread) {
      await Message.updateMany(
        {
          conversationId: { $in: conversationIds },
          direction: 'INBOUND',
          status: 'RECEIVED',
          timestamp: { $lte: latestUnread.timestamp },
        },
        { $set: { status: 'READ' } },
      );
    }

    res.json({ success: true, data: { readCount: unreadMessages.length } });
  }),
);

conversationsRouter.get(
  '/:id/messages',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const conversation = await Conversation.findById(req.params.id).select('customerId').lean();
    if (!conversation) throw new ApiError(404, 'Conversation not found', 'NOT_FOUND');
    const conversationIds = await Conversation.distinct('_id', { customerId: conversation.customerId });
    const before = typeof req.query.before === 'string' ? new Date(req.query.before) : undefined;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const filter = {
      conversationId: { $in: conversationIds },
      ...(before && !Number.isNaN(before.getTime()) ? { timestamp: { $lt: before } } : {}),
    };
    const messages = await Message.find(filter).sort({ timestamp: -1 }).limit(limit).lean();
    res.json({ success: true, data: messages.reverse() });
  }),
);

conversationsRouter.get(
  '/:id',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const conversation = await Conversation.findById(req.params.id)
      .populate('customerId', 'profileName name phoneNumber whatsappId')
      .lean();
    if (!conversation) throw new ApiError(404, 'Conversation not found', 'NOT_FOUND');
    res.json({ success: true, data: conversation });
  }),
);
