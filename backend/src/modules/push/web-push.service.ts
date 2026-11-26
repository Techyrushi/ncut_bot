import webPush from 'web-push';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { PushSubscription } from '../../database/models/push-subscription.model';
import { User } from '../../database/models/user.model';

type AdminPushPayload = {
  title: string;
  body: string;
  url: string;
};

type DeliveryResult = {
  attempted: number;
  accepted: number;
};

export function isWebPushConfigured(): boolean {
  return Boolean(env.WEB_PUSH_VAPID_PUBLIC_KEY && env.WEB_PUSH_VAPID_PRIVATE_KEY);
}

if (isWebPushConfigured()) {
  webPush.setVapidDetails(
    env.WEB_PUSH_VAPID_SUBJECT,
    env.WEB_PUSH_VAPID_PUBLIC_KEY,
    env.WEB_PUSH_VAPID_PRIVATE_KEY,
  );
}

export class WebPushService {
  async notifyAdmins(payload: AdminPushPayload): Promise<DeliveryResult> {
    if (!isWebPushConfigured()) return { attempted: 0, accepted: 0 };

    const adminIds = await User.find({ role: 'ADMIN', isActive: true }).distinct('_id');
    const subscriptions = await PushSubscription.find({ userId: { $in: adminIds } }).lean();
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        if (!subscription.keys?.p256dh || !subscription.keys.auth) {
          await PushSubscription.deleteOne({ _id: subscription._id });
          return { accepted: false };
        }
        try {
          await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
              expirationTime: subscription.expirationTime ?? null,
            },
            JSON.stringify(payload),
            { TTL: 60 * 60 },
          );
          return { accepted: true };
        } catch (error) {
          const statusCode =
            error && typeof error === 'object' && 'statusCode' in error
              ? Number(error.statusCode)
              : undefined;
          if (statusCode === 404 || statusCode === 410) {
            await PushSubscription.deleteOne({ _id: subscription._id });
            return { accepted: false };
          }
          logger.error(
            { userId: subscription.userId.toString(), statusCode },
            'Web Push delivery failed',
          );
          return { accepted: false };
        }
      }),
    );
    return {
      attempted: subscriptions.length,
      accepted: results.filter((result) => result.accepted).length,
    };
  }
}

export const webPushService = new WebPushService();
