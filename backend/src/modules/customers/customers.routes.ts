import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { BulkCampaignRecipient } from '../../database/models/bulk-campaign.model';
import { Customer } from '../../database/models/customer.model';
import { Conversation } from '../../database/models/conversation.model';
import { Lead } from '../../database/models/lead.model';
import { Message } from '../../database/models/message.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

export const customersRouter = Router();

customersRouter.get(
  '/',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const optInStatus = z.enum(['UNKNOWN', 'OPTED_IN', 'OPTED_OUT']).optional().parse(req.query.optInStatus);
    const filter = {
      ...(optInStatus ? { optInStatus } : {}),
      ...(search
        ? {
          $or: [
            { phoneNumber: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { whatsappId: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { profileName: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          ],
        }
        : {}),
    };
    const [items, total] = await Promise.all([
      Customer.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Customer.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, page, limit, total } });
  }),
);

customersRouter.patch(
  '/opt-in/bulk',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        ids: z
          .array(z.string().regex(/^[a-f\d]{24}$/i))
          .min(1)
          .max(100)
          .transform((ids) => [...new Set(ids)]),
        status: z.enum(['OPTED_IN', 'OPTED_OUT']),
        source: z.string().trim().min(1).max(500),
      })
      .parse(req.body);
    const filter = { _id: { $in: input.ids.map((id) => new Types.ObjectId(id)) } };
    const update =
      input.status === 'OPTED_IN'
        ? {
            $set: { optInStatus: input.status, optInAt: new Date(), optInSource: input.source },
          }
        : {
            $set: { optInStatus: input.status, optInSource: input.source },
            $unset: { optInAt: 1 },
          };
    const result = await Customer.updateMany(filter, update);
    res.json({
      success: true,
      data: { matchedCount: result.matchedCount, updatedCount: result.modifiedCount },
    });
  }),
);

customersRouter.patch(
  '/:id/opt-in',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        status: z.enum(['OPTED_IN', 'OPTED_OUT']),
        source: z.string().trim().min(1).max(500),
      })
      .parse(req.body);
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          optInStatus: input.status,
          ...(input.status === 'OPTED_IN' ? { optInAt: new Date(), optInSource: input.source } : {}),
          ...(input.status === 'OPTED_OUT' ? { optInSource: input.source } : {}),
        },
        ...(input.status === 'OPTED_OUT' ? { $unset: { optInAt: 1 } } : {}),
      },
      { new: true, runValidators: true },
    );
    if (!customer) throw new ApiError(404, 'Customer not found', 'NOT_FOUND');
    res.json({ success: true, data: customer });
  }),
);

customersRouter.delete(
  '/:id',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const customerId = req.params.id;
    if (typeof customerId !== 'string' || !Types.ObjectId.isValid(customerId)) {
      throw new ApiError(404, 'Customer not found', 'NOT_FOUND');
    }
    const customer = await Customer.findById(customerId);
    if (!customer) throw new ApiError(404, 'Customer not found', 'NOT_FOUND');

    const [conversations, messages, leads, campaignRecipients] = await Promise.all([
      Conversation.deleteMany({ customerId: customer._id }),
      Message.deleteMany({ customerId: customer._id }),
      Lead.deleteMany({ customerId: customer._id }),
      BulkCampaignRecipient.deleteMany({ customerId: customer._id }),
    ]);
    await customer.deleteOne();

    res.json({
      success: true,
      data: {
        id: customer.id,
        deleted: {
          conversations: conversations.deletedCount,
          messages: messages.deletedCount,
          leads: leads.deletedCount,
          campaignRecipients: campaignRecipients.deletedCount,
        },
      },
    });
  }),
);

customersRouter.get(
  '/:id',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id).lean();
    if (!customer) throw new ApiError(404, 'Customer not found', 'NOT_FOUND');
    res.json({ success: true, data: customer });
  }),
);
