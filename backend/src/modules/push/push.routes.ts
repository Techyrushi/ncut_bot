import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env';
import { PushSubscription } from '../../database/models/push-subscription.model';
import { authenticate, requireRoles, type AuthenticatedRequest } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { isWebPushConfigured } from './web-push.service';

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).refine((value) => new URL(value).protocol === 'https:'),
  expirationTime: z.number().positive().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(20).max(200),
    auth: z.string().min(10).max(100),
  }),
});

export const pushRouter = Router();

pushRouter.get(
  '/configuration',
  authenticate,
  requireRoles('ADMIN'),
  (_req, res) => {
    res.json({
      success: true,
      data: {
        enabled: isWebPushConfigured(),
        publicKey: isWebPushConfigured() ? env.WEB_PUSH_VAPID_PUBLIC_KEY : '',
      },
    });
  },
);

pushRouter.post(
  '/subscriptions',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    if (!isWebPushConfigured()) {
      res.status(503).json({
        success: false,
        error: { code: 'WEB_PUSH_NOT_CONFIGURED', message: 'Web Push is not configured on the server' },
      });
      return;
    }
    const input = subscriptionSchema.parse(req.body);
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new Error('Authenticated admin missing from push subscription request');
    await PushSubscription.findOneAndUpdate(
      { endpoint: input.endpoint },
      {
        $set: {
          userId: new Types.ObjectId(user.id),
          endpoint: input.endpoint,
          keys: input.keys,
          ...(input.expirationTime === undefined ? {} : { expirationTime: input.expirationTime }),
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    res.status(201).json({ success: true, data: { subscribed: true } });
  }),
);

pushRouter.delete(
  '/subscriptions',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const input = z.object({ endpoint: z.string().url().max(2048) }).parse(req.body);
    const user = (req as AuthenticatedRequest).user;
    if (!user) throw new Error('Authenticated admin missing from push unsubscribe request');
    await PushSubscription.deleteOne({ endpoint: input.endpoint, userId: user.id });
    res.json({ success: true, data: { subscribed: false } });
  }),
);
