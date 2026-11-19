import { Router } from 'express';
import { z } from 'zod';
import { ActivityLog } from '../../database/models/activity-log.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';

export const logsRouter = Router();

logsRouter.get(
  '/',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const pagination = z
      .object({
        page: z.coerce.number().int().min(1).max(1_000_000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse({ page: req.query.page, limit: req.query.limit });
    const { page, limit } = pagination;
    const source = z.enum(['USER', 'SYSTEM']).optional().parse(req.query.source);
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const filter: Record<string, unknown> = {};
    if (source) filter.source = source;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { action: { $regex: escaped, $options: 'i' } },
        { summary: { $regex: escaped, $options: 'i' } },
        { resourceType: { $regex: escaped, $options: 'i' } },
        { resourceId: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      ActivityLog.find(filter)
        .populate('actorId', 'name email role')
        .sort({ occurredAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ActivityLog.countDocuments(filter),
    ]);

    res.json({ success: true, data: { items, page, limit, total } });
  }),
);
