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
    const [totalCustomers, conversationStats, productSelections, totalLeads, pendingLeads] =
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
        Lead.countDocuments(),
        Lead.countDocuments({ status: 'NEW' }),
      ]);
    res.json({
      success: true,
      data: {
        totalCustomers,
        totalConversations: conversationStats[0]?.totalConversations ?? 0,
        totalProductSelections: productSelections[0]?.total ?? 0,
        totalLeads,
        pendingLeads,
        humanHandovers: conversationStats[0]?.humanHandovers ?? 0,
      },
    });
  }),
);
