import { Router } from 'express';
import { z } from 'zod';
import { WorkspaceSettings } from '../../database/models/workspace-settings.model';
import { authenticate, requireRoles, type AuthenticatedRequest } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';

export const settingsRouter = Router();

settingsRouter.get(
  '/workspace',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (_req, res) => {
    const settings = await WorkspaceSettings.findOne({ key: 'workspace' }).lean();
    res.json({
      success: true,
      data: {
        businessPhoneNumber: settings?.businessPhoneNumber ?? '',
        welcomeMessage:
          settings?.welcomeMessage ??
          '👋 Thank you for connecting with us!\n\nExplore our range of abrasive and finishing products.',
      },
    });
  }),
);

settingsRouter.patch(
  '/workspace',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        businessPhoneNumber: z
          .string()
          .trim()
          .max(30)
          .regex(/^\+?[1-9]\d{6,14}$/)
          .or(z.literal('')),
        welcomeMessage: z.string().trim().min(1).max(1024),
      })
      .parse(req.body);
    const user = (req as AuthenticatedRequest).user;
    const settings = await WorkspaceSettings.findOneAndUpdate(
      { key: 'workspace' },
      { $set: { ...input, updatedBy: user?.id }, $setOnInsert: { key: 'workspace' } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
    res.json({
      success: true,
      data: { businessPhoneNumber: settings.businessPhoneNumber, welcomeMessage: settings.welcomeMessage },
    });
  }),
);
