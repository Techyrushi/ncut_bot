import { Router } from 'express';
import { z } from 'zod';
import { Lead } from '../../database/models/lead.model';
import { User } from '../../database/models/user.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

export const leadsRouter = Router();

leadsRouter.get(
  '/',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter: Record<string, unknown> = {};
    if (typeof req.query.status === 'string') filter.status = req.query.status;
    if (typeof req.query.assignedSalesPerson === 'string') filter.assignedSalesPerson = req.query.assignedSalesPerson;
    const [items, total] = await Promise.all([
      Lead.find(filter)
        .populate('customerId', 'profileName name phoneNumber')
        .populate('selectedProducts', 'name category')
        .populate('assignedSalesPerson', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Lead.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, page, limit, total } });
  }),
);

leadsRouter.get(
  '/:id',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const lead = await Lead.findById(req.params.id)
      .populate('customerId', 'profileName name phoneNumber')
      .populate('selectedProducts', 'name category')
      .populate('assignedSalesPerson', 'name email')
      .lean();
    if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');
    res.json({ success: true, data: lead });
  }),
);

leadsRouter.patch(
  '/:id/status',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST']) }).parse(req.body);
    const lead = await Lead.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true, runValidators: true });
    if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');
    res.json({ success: true, data: lead });
  }),
);

leadsRouter.patch(
  '/:id/assign',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const { userId } = z.object({ userId: z.string().regex(/^[a-f\d]{24}$/i) }).parse(req.body);
    const user = await User.findOne({ _id: userId, isActive: true, role: 'SALES' }).select('_id');
    if (!user) throw new ApiError(404, 'Active sales representative not found', 'NOT_FOUND');
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $set: { assignedSalesPerson: user._id } },
      { new: true },
    );
    if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');
    res.json({ success: true, data: lead });
  }),
);
