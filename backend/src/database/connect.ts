import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { createModelIndexes } from './models';

export async function connectDatabase(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: env.NODE_ENV !== 'production',
  });
  await createModelIndexes();
  logger.info('MongoDB connected');
}
