import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import express from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
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
  category: z.string().trim().min(1).max(32),
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
    category: z.string().trim().min(1).max(32).optional(),
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

productsRouter.post(
  '/image-upload',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      throw new ApiError(400, 'Upload a JPEG, PNG, or WebP product image', 'INVALID_IMAGE');

    const extensionByType: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const contentType = req.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const extension = extensionByType[contentType];
    if (!extension) throw new ApiError(415, 'Only JPEG, PNG, and WebP images are supported', 'UNSUPPORTED_IMAGE');
    const bytes = req.body as Buffer;
    const validSignature =
      (extension === 'jpg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      (extension === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (extension === 'webp' &&
        bytes.length >= 12 &&
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WEBP');
    if (!validSignature) throw new ApiError(400, 'Image content does not match its file type', 'INVALID_IMAGE');

    const filename = `${randomUUID()}.${extension}`;
    const uploadDirectory = resolve(process.cwd(), 'uploads');
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(resolve(uploadDirectory, filename), bytes, { flag: 'wx', mode: 0o644 });

    res.status(201).json({
      success: true,
      data: { imageUrl: new URL(`/uploads/${filename}`, env.APP_URL).toString() },
    });
  }),
);

productsRouter.get(
  '/categories',
  authenticate,
  asyncHandler(async (_req, res) => {
    const categories = await Product.distinct('category');
    res.json({
      success: true,
      data: categories.filter((category): category is string => typeof category === 'string').sort((a, b) =>
        a.localeCompare(b),
      ),
    });
  }),
);

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
