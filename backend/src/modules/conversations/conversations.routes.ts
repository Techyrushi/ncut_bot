import { Router } from 'express';
import { z } from 'zod';
import { Conversation } from '../../database/models/conversation.model';
import { Message } from '../../database/models/message.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

export const conversationsRouter = Router();

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
    const [items, total] = await Promise.all([
      Conversation.find(filter)
        .populate('customerId', 'profileName name phoneNumber whatsappId')
        .sort({ lastMessageAt: -1, updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Conversation.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, page, limit, total } });
  }),
);

conversationsRouter.get(
  '/:id/messages',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const conversation = await Conversation.exists({ _id: req.params.id });
    if (!conversation) throw new ApiError(404, 'Conversation not found', 'NOT_FOUND');
    const before = typeof req.query.before === 'string' ? new Date(req.query.before) : undefined;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const filter = {
      conversationId: req.params.id,
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
