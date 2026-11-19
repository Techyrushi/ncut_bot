import { Router } from 'express';
import { env } from '../../config/env';
import { asyncHandler } from '../../utils/async-handler';
import { enqueueWebhookPayload, verifySignature } from './webhook.processor';

export const whatsappWebhookRouter = Router();

whatsappWebhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  res
    .status(403)
    .json({ success: false, error: { code: 'WEBHOOK_VERIFICATION_FAILED', message: 'Webhook verification failed' } });
});

whatsappWebhookRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !verifySignature(req.body, req.header('x-hub-signature-256'))) {
      res
        .status(401)
        .json({ success: false, error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Invalid webhook signature' } });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_WEBHOOK_PAYLOAD', message: 'Invalid JSON payload' } });
      return;
    }
    await enqueueWebhookPayload(payload);
    res.status(200).json({ success: true });
  }),
);
