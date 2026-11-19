import { Router } from 'express';
import { z } from 'zod';
import { Customer } from '../../database/models/customer.model';
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
    const filter = search
      ? {
          $or: [
            { phoneNumber: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { profileName: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          ],
        }
      : {};
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
