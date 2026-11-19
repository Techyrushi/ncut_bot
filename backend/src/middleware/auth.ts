import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { RevokedToken } from '../database/models/revoked-token.model';
import { User } from '../database/models/user.model';
import { ApiError } from '../utils/api-error';

export interface AuthenticatedRequest extends Request {
  user?: { id: string; role: 'ADMIN' | 'SALES'; tokenId: string; expiresAt: Date };
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    next(new ApiError(401, 'Authentication required', 'UNAUTHORIZED'));
    return;
  }
  try {
    const claims = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    const tokenVersion = claims.ver === undefined ? 0 : claims.ver;
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.jti !== 'string' ||
      typeof claims.exp !== 'number' ||
      typeof tokenVersion !== 'number' ||
      !Number.isInteger(tokenVersion) ||
      (claims.role !== 'ADMIN' && claims.role !== 'SALES')
    ) {
      throw new Error('Invalid token claims');
    }
    void Promise.all([
      RevokedToken.exists({ tokenId: claims.jti }),
      User.findOne({ _id: claims.sub, isActive: true }).select('_id role authVersion').lean(),
    ])
      .then(([revoked, user]) => {
        if (revoked || !user || (user.authVersion ?? 0) !== tokenVersion) {
          next(new ApiError(401, 'Invalid or expired authentication token', 'UNAUTHORIZED'));
          return;
        }
        (req as AuthenticatedRequest).user = {
          id: claims.sub as string,
          role: user.role,
          tokenId: claims.jti as string,
          expiresAt: new Date((claims.exp as number) * 1000),
        };
        next();
      })
      .catch(next);
  } catch {
    next(new ApiError(401, 'Invalid or expired authentication token', 'UNAUTHORIZED'));
  }
}

export function requireRoles(...roles: Array<'ADMIN' | 'SALES'>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || !roles.includes(user.role)) {
      next(new ApiError(403, 'You do not have permission to perform this action', 'FORBIDDEN'));
      return;
    }
    next();
  };
}
