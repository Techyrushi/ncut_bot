import { Router } from 'express';
import { Conversation } from '../../database/models/conversation.model';
import { Customer } from '../../database/models/customer.model';
import { Lead } from '../../database/models/lead.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/stats',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (_req, res) => {
    const [totalCustomers, conversationStats, productSelections, leadStats] =
      await Promise.all([
        Customer.countDocuments(),
        Conversation.aggregate([
          {
            $addFields: {
              activePriority: { $cond: [{ $in: ['$status', ['OPEN', 'HUMAN_HANDOVER']] }, 1, 0] },
            },
          },
          { $sort: { customerId: 1, activePriority: -1, updatedAt: -1, lastMessageAt: -1 } },
          { $group: { _id: '$customerId', status: { $first: '$status' } } },
          {
            $group: {
              _id: null,
              totalConversations: { $sum: 1 },
              humanHandovers: { $sum: { $cond: [{ $eq: ['$status', 'HUMAN_HANDOVER'] }, 1, 0] } },
            },
          },
        ]),
        Conversation.aggregate([
          { $unwind: '$selectedProductIds' },
          { $group: { _id: { customerId: '$customerId', productId: '$selectedProductIds' } } },
          { $count: 'total' },
        ]),
        Lead.aggregate([
          {
            $lookup: {
              from: Customer.collection.name,
              localField: 'customerId',
              foreignField: '_id',
              as: 'customer',
            },
          },
          { $unwind: '$customer' },
          {
            $addFields: {
              phoneIdentity: { $ifNull: ['$customer.phoneIdentity', '$customer._id'] },
            },
          },
          { $sort: { updatedAt: -1, createdAt: -1 } },
          { $group: { _id: '$phoneIdentity', status: { $first: '$status' } } },
          {
            $group: {
              _id: null,
              totalLeads: { $sum: 1 },
              pendingLeads: { $sum: { $cond: [{ $eq: ['$status', 'NEW'] }, 1, 0] } },
            },
          },
        ]),
      ]);
    res.json({
      success: true,
      data: {
        totalCustomers,
        totalConversations: conversationStats[0]?.totalConversations ?? 0,
        totalProductSelections: productSelections[0]?.total ?? 0,
        totalLeads: leadStats[0]?.totalLeads ?? 0,
        pendingLeads: leadStats[0]?.pendingLeads ?? 0,
        humanHandovers: conversationStats[0]?.humanHandovers ?? 0,
      },
    });
  }),
);
