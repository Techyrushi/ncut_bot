import { Router } from 'express';
import { z } from 'zod';
import { Product } from '../../database/models/product.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

const productSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(5000),
  category: z.string().trim().min(1).max(24),
  sizes: z.array(z.string().trim()).default([]),
  grits: z.array(z.string().trim()).default([]),
  colours: z.array(z.string().trim()).default([]),
  backing: z.array(z.string().trim()).default([]),
  specifications: z.record(z.string(), z.unknown()).default({}),
  imageUrl: z.string().url().optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});

const productUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    description: z.string().trim().min(1).max(5000).optional(),
    category: z.string().trim().min(1).max(24).optional(),
    sizes: z.array(z.string().trim()).optional(),
    grits: z.array(z.string().trim()).optional(),
    colours: z.array(z.string().trim()).optional(),
    backing: z.array(z.string().trim()).optional(),
    specifications: z.record(z.string(), z.unknown()).optional(),
    imageUrl: z.string().url().optional().or(z.literal('')),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one product field must be provided');

export const productsRouter = Router();

productsRouter.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter: Record<string, unknown> = {};
    if (req.query.active !== 'all') filter.isActive = req.query.active === 'false' ? false : true;
    if (typeof req.query.category === 'string') filter.category = req.query.category;
    if (typeof req.query.search === 'string' && req.query.search.trim())
      filter.$text = { $search: req.query.search.trim() };
    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, page, limit, total } });
  }),
);

productsRouter.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id).lean();
    if (!product) throw new ApiError(404, 'Product not found', 'NOT_FOUND');
    res.json({ success: true, data: product });
  }),
);

productsRouter.post(
  '/',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const product = await Product.create(productSchema.parse(req.body));
    res.status(201).json({ success: true, data: product });
  }),
);

productsRouter.put(
  '/:id',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const values = productUpdateSchema.parse(req.body);
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: values },
      { new: true, runValidators: true },
    );
    if (!product) throw new ApiError(404, 'Product not found', 'NOT_FOUND');
    res.json({ success: true, data: product });
  }),
);

productsRouter.delete(
  '/:id',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const product = await Product.findByIdAndUpdate(req.params.id, { $set: { isActive: false } }, { new: true });
    if (!product) throw new ApiError(404, 'Product not found', 'NOT_FOUND');
    res.json({ success: true, data: { id: product.id, isActive: product.isActive } });
  }),
);
