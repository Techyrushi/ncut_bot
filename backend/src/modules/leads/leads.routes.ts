import { Router } from 'express';
import { Types, type PipelineStage } from 'mongoose';
import { z } from 'zod';
import { Customer } from '../../database/models/customer.model';
import { Lead, SALES_FOLLOW_UP_REQUIREMENT } from '../../database/models/lead.model';
import { Product } from '../../database/models/product.model';
import { User } from '../../database/models/user.model';
import { Conversation } from '../../database/models/conversation.model';
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
  unread: z.enum(['true', 'false']).optional(),
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
    unread: query.unread,
  });
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    throw new ApiError(400, 'Start date must be on or before end date', 'INVALID_DATE_RANGE');
  }

  const clauses: Record<string, unknown>[] = [];
  if (filters.status) clauses.push({ status: filters.status });
  if (filters.unread === 'true') clauses.push({ adminReadAt: { $exists: false } });
  if (filters.assignedSalesPerson === 'unassigned') {
    clauses.push({
      $or: [{ assignedSalesPerson: { $exists: false } }, { assignedSalesPerson: null }],
    });
  } else if (filters.assignedSalesPerson === 'assigned') {
    clauses.push({ assignedSalesPerson: { $exists: true, $ne: null } });
  } else if (filters.assignedSalesPerson) {
    clauses.push({ assignedSalesPerson: new Types.ObjectId(filters.assignedSalesPerson) });
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
        { feedback: regex },
        ...(filters.search.match(/^[a-f\d]{24}$/i) ? [{ _id: new Types.ObjectId(filters.search) }] : []),
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
    typeof lead.requirement === 'string' && lead.requirement.trim()
      ? lead.requirement.trim()
      : SALES_FOLLOW_UP_REQUIREMENT,
    String(assignee.name ?? ''),
    String(lead.status ?? ''),
    typeof lead.feedback === 'string' && lead.feedback.trim() ? lead.feedback.trim() : 'Not provided',
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

type LeadGroup = {
  _id: string | Types.ObjectId;
  leadId: Types.ObjectId;
  customerIds: Types.ObjectId[];
  leadHistory: Array<{ leadId: Types.ObjectId; conversationId: Types.ObjectId; status: string; createdAt: Date }>;
  visitHistory: Array<Array<{ whatsappMessageId: string; conversationId: Types.ObjectId; occurredAt: Date }>>;
  isUnreadLead: number;
};

function phoneIdentityStages(): PipelineStage[] {
  return [
    {
      $lookup: {
        from: Customer.collection.name,
        localField: 'customerId',
        foreignField: '_id',
        as: 'customer',
      },
    },
    { $unwind: '$customer' },
    {
      $addFields: {
        phoneIdentity: { $ifNull: ['$customer.phoneIdentity', '$customer._id'] },
      },
    },
  ];
}

async function getLeadGroups(
  filter: Record<string, unknown>,
  page?: { skip: number; limit: number },
): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
  const facets = await Lead.aggregate<{
    items: LeadGroup[];
    total: Array<{ count: number }>;
  }>([
    { $match: filter },
    ...phoneIdentityStages(),
    { $sort: { updatedAt: -1, createdAt: -1 } },
    {
      $group: {
        _id: '$phoneIdentity',
        leadId: { $first: '$_id' },
        latestUpdatedAt: { $first: '$updatedAt' },
        customerIds: { $addToSet: '$customerId' },
        leadHistory: {
          $push: {
            leadId: '$_id',
            conversationId: '$conversationId',
            status: '$status',
            createdAt: '$createdAt',
          },
        },
        visitHistory: { $push: { $ifNull: ['$visitHistory', []] } },
        isUnreadLead: {
          $max: {
            $cond: [{ $eq: [{ $ifNull: ['$adminReadAt', null] }, null] }, 1, 0],
          },
        },
      },
    },
    { $sort: { latestUpdatedAt: -1 } },
    {
      $facet: {
        items: page ? [{ $skip: page.skip }, { $limit: page.limit }] : [{ $match: {} }],
        total: [{ $count: 'count' }],
      },
    },
  ]);
  const groups = facets[0]?.items ?? [];
  const leadIds = groups.map((group) => group.leadId);
  const customerIds = groups.flatMap((group) => group.customerIds);
  const [leads, conversations] = await Promise.all([
    leadIds.length ? populatedLeadFields({ _id: { $in: leadIds } }).lean() : [],
    customerIds.length
      ? Conversation.aggregate<{
          _id: string;
          latestConversationId: Types.ObjectId;
          chatHistoryCount: number;
        }>([
          { $match: { customerId: { $in: customerIds } } },
          ...phoneIdentityStages(),
          {
            $addFields: {
              activePriority: { $cond: [{ $in: ['$status', ['OPEN', 'HUMAN_HANDOVER']] }, 1, 0] },
            },
          },
          { $sort: { phoneIdentity: 1, activePriority: -1, lastMessageAt: -1, updatedAt: -1 } },
          {
            $group: {
              _id: '$phoneIdentity',
              latestConversationId: { $first: '$_id' },
              chatHistoryCount: { $sum: 1 },
            },
          },
        ])
      : [],
  ]);
  const leadById = new Map(leads.map((lead) => [String(lead._id), lead as Record<string, unknown>]));
  const conversationByPhone = new Map(conversations.map((row) => [String(row._id), row]));
  const items = groups.flatMap((group) => {
    const lead = leadById.get(String(group.leadId));
    if (!lead) return [];
    const history = conversationByPhone.get(String(group._id));
    const visitIds = new Set(
      group.visitHistory
        .flat()
        .map((visit) => visit.whatsappMessageId)
        .filter(Boolean),
    );
    return [{
      ...lead,
      requirement:
        typeof lead.requirement === 'string' && lead.requirement.trim()
          ? lead.requirement.trim()
          : SALES_FOLLOW_UP_REQUIREMENT,
      isUnreadLead: group.isUnreadLead === 1,
      leadHistory: group.leadHistory,
      chatHistoryCount: visitIds.size || history?.chatHistoryCount || 0,
      latestConversationId: history?.latestConversationId ?? lead.conversationId,
    }];
  });
  return { items, total: facets[0]?.total[0]?.count ?? 0 };
}

export const leadsRouter = Router();

leadsRouter.get(
  '/export.csv',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const filter = await buildLeadFilter(req.query as Record<string, unknown>);
    const { items: leads } = await getLeadGroups(filter);
    const header = [
      'Lead ID',
      'Customer',
      'WhatsApp number',
      'Products',
      'Requirement',
      'Assignee',
      'Status',
      'Feedback',
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
    const { items, total } = await getLeadGroups(filter, { skip: (page - 1) * limit, limit });
    res.json({ success: true, data: { items, page, limit, total } });
  }),
);

leadsRouter.patch(
  '/:id/read',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const lead = await Lead.findById(req.params.id).select('customerId');
    if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');
    const customer = await Customer.findById(lead.customerId).select('phoneNumber whatsappId phoneIdentity');
    if (!customer) throw new ApiError(404, 'Lead customer not found', 'NOT_FOUND');
    const customers = await Customer.find(
      customer.phoneIdentity ? { phoneIdentity: customer.phoneIdentity } : { _id: customer._id },
    ).distinct('_id');
    const readAt = new Date();
    await Lead.updateMany(
      { customerId: { $in: customers } },
      { $set: { adminReadAt: readAt } },
    );
    res.json({ success: true, data: { readAt } });
  }),
);

leadsRouter.get(
  '/:id',
  authenticate,
  requireRoles('ADMIN'),
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
