import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import { errorHandler } from './middleware/error-handler';
import { authRouter } from './modules/auth/auth.routes';
import { teamRouter } from './modules/auth/team.routes';
import { conversationsRouter } from './modules/conversations/conversations.routes';
import { customersRouter } from './modules/customers/customers.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { leadsRouter } from './modules/leads/leads.routes';
import { productsRouter } from './modules/products/products.routes';
import { whatsappRouter } from './modules/whatsapp/whatsapp.routes';
import { whatsappConfigRouter } from './modules/whatsapp/config.routes';
import { whatsappWebhookRouter } from './modules/webhook/webhook.routes';
import { templatesRouter } from './modules/templates/templates.routes';
import { settingsRouter } from './modules/settings/settings.routes';
import { activityLogMiddleware } from './modules/logs/activity-log';
import { logsRouter } from './modules/logs/logs.routes';
import { bulkCampaignsRouter } from './modules/bulk-campaigns/bulk-campaigns.routes';
import mongoose from 'mongoose';
import { resolve } from 'node:path';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(helmet());
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);
app.use(pinoHttp({ logger }));
app.use(activityLogMiddleware);
app.use(
  '/uploads',
  (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(resolve(process.cwd(), 'uploads'), { index: false, maxAge: '1d' }),
);
app.use(
  '/api/v1/webhooks/whatsapp',
  rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }),
  express.raw({ type: 'application/json', limit: '1mb' }),
  whatsappWebhookRouter,
);
app.use(express.json({ limit: '1mb' }));
app.use(
  '/api/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
  }),
);

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/team', teamRouter);
app.use('/api/v1/products', productsRouter);
app.use('/api/v1/customers', customersRouter);
app.use('/api/v1/conversations', conversationsRouter);
app.use('/api/v1/leads', leadsRouter);
app.use('/api/v1/whatsapp', whatsappRouter);
app.use('/api/v1/whatsapp/configuration', whatsappConfigRouter);
app.use('/api/v1/templates', templatesRouter);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/logs', logsRouter);
app.use('/api/v1/bulk-campaigns', bulkCampaignsRouter);

app.get('/api/v1/health', (_req, res) => {
  const isConnected = mongoose.connection.readyState === 1;
  res.status(isConnected ? 200 : 503).json({
    success: isConnected,
    data: {
      status: isConnected ? 'ok' : 'degraded',
      database: isConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    },
  });
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
});
app.use(errorHandler);
