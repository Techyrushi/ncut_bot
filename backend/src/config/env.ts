import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const envPath = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')].find(existsSync);
if (envPath) dotenv.config({ path: envPath });
else dotenv.config();

const optionalSecret = z.string().optional().default('');
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(5000),
    APP_URL: z.string().url().default('http://localhost:5000'),
    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
    WHATSAPP_ACCESS_TOKEN: optionalSecret,
    WHATSAPP_PHONE_NUMBER_ID: optionalSecret,
    WHATSAPP_BUSINESS_ACCOUNT_ID: optionalSecret,
    WHATSAPP_APP_SECRET: optionalSecret,
    WHATSAPP_VERIFY_TOKEN: optionalSecret,
    META_GRAPH_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/)
      .default('v27.0'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must contain at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('1d'),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    SALES_NOTIFICATION_PROVIDER: z.enum(['log', 'webhook']).default('log'),
    SALES_NOTIFICATION_TARGET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().url().optional().default(''),
    ),
    ADMIN_EMAIL: z.preprocess((value) => (value === '' ? undefined : value), z.string().email().optional()),
    ADMIN_PASSWORD: optionalSecret,
    WEBHOOK_PROCESSING_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === 'production') {
      const required = [
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_PHONE_NUMBER_ID',
        'WHATSAPP_BUSINESS_ACCOUNT_ID',
        'WHATSAPP_APP_SECRET',
        'WHATSAPP_VERIFY_TOKEN',
      ] as const;
      for (const key of required) {
        if (!config[key])
          context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'is required in production' });
      }
      if (config.SALES_NOTIFICATION_PROVIDER === 'webhook' && !config.SALES_NOTIFICATION_TARGET) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SALES_NOTIFICATION_TARGET'],
          message: 'is required when webhook notifications are enabled',
        });
      }
      if (
        config.SALES_NOTIFICATION_PROVIDER === 'webhook' &&
        !config.SALES_NOTIFICATION_TARGET.startsWith('https://')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SALES_NOTIFICATION_TARGET'],
          message: 'must use HTTPS in production',
        });
      }
    }
  });

const result = schema.safeParse(process.env);
if (!result.success) {
  const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = result.data;
export const hasWhatsAppConfig = (): boolean => Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
