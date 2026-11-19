import type { NextFunction, Request, Response } from 'express';
import { ActivityLog } from '../../database/models/activity-log.model';
import { type AuthenticatedRequest } from '../../middleware/auth';
import { logger } from '../../config/logger';

type ActivityInput = {
  action: string;
  summary?: string;
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  actorRole?: 'ADMIN' | 'SALES';
  source: 'USER' | 'SYSTEM';
  statusCode?: number;
};

export async function recordActivity(input: ActivityInput): Promise<void> {
  try {
    await ActivityLog.create(input);
  } catch (error) {
    logger.error({ err: error, action: input.action }, 'Unable to persist activity log');
  }
}

export async function recordSystemActivity(action: string, summary: string): Promise<void> {
  await recordActivity({ source: 'SYSTEM', action, summary });
}

export function activityLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.once('finish', () => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;

    const routePath = req.route ? `${req.baseUrl}${req.route.path}` : req.path;
    const routeParts = req.baseUrl.split('/').filter(Boolean);
    const resourceType = routeParts[2] ?? 'api';
    const requestId = req.params.id;
    const resourceId = typeof requestId === 'string' && /^[a-f\d]{24}$/i.test(requestId) ? requestId : undefined;
    void recordActivity({
      source: 'USER',
      action: `${req.method} ${routePath}`.slice(0, 180),
      resourceType,
      resourceId,
      actorId: user.id,
      actorRole: user.role,
      statusCode: res.statusCode,
    });
  });
  next();
}
