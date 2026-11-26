import { Router } from 'express';
import { z } from 'zod';
import { MessageTemplate } from '../../database/models/message-template.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

const templateInput = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]+$/)
    .max(512),
  metaTemplateId: z.string().trim().regex(/^\d{8,30}$/).optional(),
  languageCode: z.string().trim().min(2).max(20),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  metaStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAUSED']).default('PENDING'),
  components: z.array(z.record(z.string(), z.unknown())).default([]),
  defaultSendComponents: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const templatesRouter = Router();

templatesRouter.get(
  '/',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (_req, res) => {
    const items = await MessageTemplate.find().sort({ name: 1, languageCode: 1 }).lean();
    res.json({ success: true, data: items });
  }),
);

templatesRouter.post(
  '/',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const template = await MessageTemplate.create(templateInput.parse(req.body));
    res.status(201).json({ success: true, data: template });
  }),
);

templatesRouter.patch(
  '/:id/default-send-components',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const { defaultSendComponents } = z
      .object({ defaultSendComponents: z.array(z.record(z.string(), z.unknown())).max(20) })
      .parse(req.body);
    const template = await MessageTemplate.findByIdAndUpdate(
      req.params.id,
      { $set: { defaultSendComponents } },
      { new: true, runValidators: true },
    );
    if (!template) throw new ApiError(404, 'Message template not found', 'NOT_FOUND');
    res.json({ success: true, data: template });
  }),
);

templatesRouter.patch(
  '/:id/status',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const { metaStatus } = z
      .object({ metaStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAUSED']) })
      .parse(req.body);
    const template = await MessageTemplate.findByIdAndUpdate(
      req.params.id,
      { $set: { metaStatus } },
      { new: true, runValidators: true },
    );
    if (!template) throw new ApiError(404, 'Message template not found', 'NOT_FOUND');
    res.json({ success: true, data: template });
  }),
);
