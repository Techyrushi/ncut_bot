import { Router } from 'express';
import { env, hasWhatsAppConfig } from '../../config/env';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { whatsappService } from './whatsapp.service';

export const whatsappConfigRouter = Router();

whatsappConfigRouter.get('/', authenticate, requireRoles('ADMIN', 'SALES'), (_req, res) => {
  const sendConfigured = hasWhatsAppConfig();
  const webhookConfigured = Boolean(env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN);
  res.json({
    success: true,
    data: {
      configured: sendConfigured && webhookConfigured && Boolean(env.WHATSAPP_BUSINESS_ACCOUNT_ID),
      sendConfigured,
      webhookConfigured,
      accessTokenConfigured: Boolean(env.WHATSAPP_ACCESS_TOKEN),
      graphApiVersion: env.META_GRAPH_API_VERSION,
      phoneNumberIdConfigured: Boolean(env.WHATSAPP_PHONE_NUMBER_ID),
      businessAccountConfigured: Boolean(env.WHATSAPP_BUSINESS_ACCOUNT_ID),
      appSecretConfigured: Boolean(env.WHATSAPP_APP_SECRET),
      verifyTokenConfigured: Boolean(env.WHATSAPP_VERIFY_TOKEN),
      webhookEndpoint: new URL('/api/v1/webhooks/whatsapp', env.APP_URL).toString(),
      notificationProvider: env.SALES_NOTIFICATION_PROVIDER,
    },
  });
});

whatsappConfigRouter.post(
  '/test-connection',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (_req, res) => {
    const connection = await whatsappService.testConnection();
    res.json({ success: true, data: connection });
  }),
);
