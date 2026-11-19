import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env';
import { User } from '../../database/models/user.model';
import { RevokedToken } from '../../database/models/revoked-token.model';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

const credentialsSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(200),
});
const accountUpdateSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    email: z
      .string()
      .email()
      .transform((value) => value.toLowerCase())
      .optional(),
    newPassword: z.string().min(12).max(200).optional(),
  })
  .strict()
  .refine((value) => value.email !== undefined || value.newPassword !== undefined);

export const authRouter = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const credentials = credentialsSchema.parse(req.body);
    const user = await User.findOne({ email: credentials.email, isActive: true }).select('+passwordHash');
    if (!user || !(await compare(credentials.password, user.passwordHash))) {
      throw new ApiError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }
    const token = jwt.sign({ role: user.role, ver: user.authVersion ?? 0 }, env.JWT_SECRET, {
      subject: user.id,
      jwtid: randomUUID(),
      expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });
    res.json({
      success: true,
      data: { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } },
    });
  }),
);

authRouter.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    const { tokenId, expiresAt } = (req as AuthenticatedRequest).user!;
    await RevokedToken.updateOne({ tokenId }, { $setOnInsert: { tokenId, expiresAt } }, { upsert: true });
    res.json({ success: true, data: { message: 'Logged out successfully.' } });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const { id } = (req as AuthenticatedRequest).user!;
    const user = await User.findOne({ _id: id, isActive: true }).select('email name role').lean();
    if (!user) throw new ApiError(401, 'User account is inactive or unavailable', 'UNAUTHORIZED');
    res.json({
      success: true,
      data: { id: String(user._id), email: user.email, name: user.name, role: user.role },
    });
  }),
);

authRouter.patch(
  '/account',
  authenticate,
  asyncHandler(async (req, res) => {
    const update = accountUpdateSchema.parse(req.body);
    const { id } = (req as AuthenticatedRequest).user!;
    const user = await User.findOne({ _id: id, isActive: true }).select('+passwordHash');
    if (!user || !(await compare(update.currentPassword, user.passwordHash))) {
      throw new ApiError(403, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    }

    if (update.email && update.email !== user.email) {
      const emailInUse = await User.exists({ email: update.email, _id: { $ne: user._id } });
      if (emailInUse) throw new ApiError(409, 'Email address is already in use', 'EMAIL_IN_USE');
      user.email = update.email;
    }
    if (update.newPassword) user.passwordHash = await hash(update.newPassword, 12);

    user.authVersion = (user.authVersion ?? 0) + 1;
    await user.save();

    const token = jwt.sign({ role: user.role, ver: user.authVersion }, env.JWT_SECRET, {
      subject: user.id,
      jwtid: randomUUID(),
      expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });
    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
      },
    });
  }),
);
