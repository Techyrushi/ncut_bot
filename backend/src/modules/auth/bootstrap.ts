import { hash } from 'bcryptjs';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { User } from '../../database/models/user.model';

export async function initializeAdminUser(): Promise<void> {
  if (!env.ADMIN_EMAIL && !env.ADMIN_PASSWORD) {
    logger.warn('No bootstrap administrator configured; set ADMIN_EMAIL and ADMIN_PASSWORD before using the admin API');
    return;
  }
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) {
    throw new Error(
      'Configure both ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) to bootstrap the administrator',
    );
  }
  const existing = await User.findOne({ email: env.ADMIN_EMAIL.toLowerCase() }).select('_id');
  if (existing) return;
  await User.create({
    email: env.ADMIN_EMAIL.toLowerCase(),
    name: 'Workspace Administrator',
    passwordHash: await hash(env.ADMIN_PASSWORD, 12),
    role: 'ADMIN',
  });
  logger.info({ email: env.ADMIN_EMAIL }, 'Initial administrator account created');
}
