import { Router } from 'express';
import { z } from 'zod';
import { Customer } from '../../database/models/customer.model';
import { Lead } from '../../database/models/lead.model';
import { Product } from '../../database/models/product.model';
import { User } from '../../database/models/user.model';
import { authenticate, requireRoles } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

const leadStatuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST'] as const;
const leadFiltersSchema = z.object({
  status: z.enum(leadStatuses).optional(),
  assignedSalesPerson: z.union([
    z.string().regex(/^[a-f\d]{24}$/i),
    z.enum(['assigned', 'unassigned']),
  ]).optional(),
  search: z.string().trim().max(200).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
});

function escapedRegex(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

async function buildLeadFilter(query: Record<string, unknown>): Promise<Record<string, unknown>> {
  const filters = leadFiltersSchema.parse({
    status: query.status,
    assignedSalesPerson: query.assignedSalesPerson,
    search: query.search,
    startDate: query.startDate,
    endDate: query.endDate,
  });
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    throw new ApiError(400, 'Start date must be on or before end date', 'INVALID_DATE_RANGE');
  }

  const clauses: Record<string, unknown>[] = [];
  if (filters.status) clauses.push({ status: filters.status });
  if (filters.assignedSalesPerson === 'unassigned') {
    clauses.push({
      $or: [{ assignedSalesPerson: { $exists: false } }, { assignedSalesPerson: null }],
    });
  } else if (filters.assignedSalesPerson === 'assigned') {
    clauses.push({ assignedSalesPerson: { $exists: true, $ne: null } });
  } else if (filters.assignedSalesPerson) {
    clauses.push({ assignedSalesPerson: filters.assignedSalesPerson });
  }
  if (filters.startDate || filters.endDate) {
    clauses.push({
      createdAt: {
        ...(filters.startDate ? { $gte: new Date(`${filters.startDate}T00:00:00.000Z`) } : {}),
        ...(filters.endDate ? { $lte: new Date(`${filters.endDate}T23:59:59.999Z`) } : {}),
      },
    });
  }
  if (filters.search) {
    const regex = escapedRegex(filters.search);
    const [customers, products] = await Promise.all([
      Customer.find({ $or: [{ profileName: regex }, { name: regex }, { phoneNumber: regex }] }).distinct('_id'),
      Product.find({ $or: [{ name: regex }, { category: regex }] }).distinct('_id'),
    ]);
    clauses.push({
      $or: [
        { customerId: { $in: customers } },
        { selectedProducts: { $in: products } },
        { requirement: regex },
        ...(filters.search.match(/^[a-f\d]{24}$/i) ? [{ _id: filters.search }] : []),
      ],
    });
  }
  return clauses.length ? { $and: clauses } : {};
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function leadCsvRow(lead: Record<string, unknown>): string[] {
  const customer =
    lead.customerId && typeof lead.customerId === 'object' ? (lead.customerId as Record<string, unknown>) : {};
  const assignee =
    lead.assignedSalesPerson && typeof lead.assignedSalesPerson === 'object'
      ? (lead.assignedSalesPerson as Record<string, unknown>)
      : {};
  const products = Array.isArray(lead.selectedProducts) ? lead.selectedProducts : [];
  const productNames = products
    .map((product) =>
      product && typeof product === 'object' && 'name' in product ? String(product.name) : '',
    )
    .filter(Boolean)
    .join('; ');
  return [
    String(lead._id ?? ''),
    String(customer.profileName ?? customer.name ?? 'Customer'),
    String(customer.phoneNumber ?? ''),
    productNames,
    String(lead.requirement ?? ''),
    String(assignee.name ?? ''),
    String(lead.status ?? ''),
    String(lead.notificationStatus ?? 'PENDING'),
    lead.createdAt instanceof Date ? lead.createdAt.toISOString() : String(lead.createdAt ?? ''),
    lead.updatedAt instanceof Date ? lead.updatedAt.toISOString() : String(lead.updatedAt ?? ''),
  ];
}

const populatedLeadFields = (filter: Record<string, unknown> = {}) =>
  Lead.find(filter)
    .populate('customerId', 'profileName name phoneNumber')
    .populate('selectedProducts', 'name category')
    .populate('assignedSalesPerson', 'name email isActive');

export const leadsRouter = Router();

leadsRouter.get(
  '/export.csv',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const filter = await buildLeadFilter(req.query as Record<string, unknown>);
    const leads = await populatedLeadFields(filter).sort({ createdAt: -1 }).lean();
    const header = [
      'Lead ID',
      'Customer',
      'WhatsApp number',
      'Products',
      'Requirement',
      'Assignee',
      'Status',
      'Notification status',
      'Created at',
      'Updated at',
    ];
    const csv = [header, ...leads.map((lead) => leadCsvRow(lead as Record<string, unknown>))]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');
    res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .attachment(`ncut-leads-${new Date().toISOString().slice(0, 10)}.csv`)
      .send(`\uFEFF${csv}`);
  }),
);

leadsRouter.get(
  '/',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter = await buildLeadFilter(req.query as Record<string, unknown>);
    const [items, total] = await Promise.all([
      populatedLeadFields(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Lead.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, page, limit, total } });
  }),
);

leadsRouter.get(
  '/:id',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const lead = await Lead.findById(req.params.id)
      .populate('customerId', 'profileName name phoneNumber')
      .populate('selectedProducts', 'name category')
      .populate('assignedSalesPerson', 'name email isActive')
      .lean();
    if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');
    res.json({ success: true, data: lead });
  }),
);

leadsRouter.patch(
  '/:id/status',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(leadStatuses) }).parse(req.body);
    const lead = await Lead.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true, runValidators: true });
    if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');
    res.json({ success: true, data: lead });
  }),
);

leadsRouter.patch(
  '/:id/assign',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const { userId } = z.object({ userId: z.union([z.string().regex(/^[a-f\d]{24}$/i), z.literal('')]) }).parse(req.body);
    if (userId) {
      const user = await User.findOne({ _id: userId, isActive: true, role: 'SALES' }).select('_id');
      if (!user) throw new ApiError(404, 'Active sales representative not found', 'NOT_FOUND');
    }
    const lead = userId
      ? await Lead.findByIdAndUpdate(
          req.params.id,
          { $set: { assignedSalesPerson: userId } },
          { new: true, runValidators: true },
        )
      : await Lead.findByIdAndUpdate(
          req.params.id,
          { $unset: { assignedSalesPerson: 1 } },
          { new: true, runValidators: true },
        );
    if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');
    res.json({ success: true, data: lead });
  }),
);
