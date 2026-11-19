import { hash } from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { User } from '../../database/models/user.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

export const teamRouter = Router();

teamRouter.get(
  '/',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (_req, res) => {
    const users = await User.find({ role: 'SALES' })
      .select('name email role isActive createdAt')
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, data: users });
  }),
);

teamRouter.post(
  '/',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(120),
        email: z
          .string()
          .email()
          .transform((value) => value.toLowerCase()),
        password: z.string().min(12).max(200),
      })
      .parse(req.body);
    const user = await User.create({ ...input, passwordHash: await hash(input.password, 12), role: 'SALES' });
    res.status(201).json({ success: true, data: { id: user.id, name: user.name, email: user.email, role: user.role } });
  }),
);

teamRouter.patch(
  '/:id',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'SALES' },
      { $set: { isActive } },
      { new: true },
    ).select('name email role isActive');
    if (!user) throw new ApiError(404, 'Sales representative not found', 'NOT_FOUND');
    res.json({ success: true, data: user });
  }),
);
