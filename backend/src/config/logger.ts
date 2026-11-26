import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    "req.headers['x-hub-signature-256']",
    'req.query',
    'req.url',
    '*.WHATSAPP_ACCESS_TOKEN',
    '*.ADMIN_WHATSAPP_NUMBER',
    '*.JWT_SECRET',
  ],
});
