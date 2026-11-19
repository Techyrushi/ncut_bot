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
    const [totalCustomers, totalConversations, productSelections, totalLeads, pendingLeads, humanHandovers] =
      await Promise.all([
        Customer.countDocuments(),
        Conversation.countDocuments(),
        Conversation.aggregate([{ $group: { _id: null, total: { $sum: '$uniqueProductCount' } } }]),
        Lead.countDocuments(),
        Lead.countDocuments({ status: 'NEW' }),
        Conversation.countDocuments({ status: 'HUMAN_HANDOVER' }),
      ]);
    res.json({
      success: true,
      data: {
        totalCustomers,
        totalConversations,
        totalProductSelections: productSelections[0]?.total ?? 0,
        totalLeads,
        pendingLeads,
        humanHandovers,
      },
    });
  }),
);
