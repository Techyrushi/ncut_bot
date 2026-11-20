import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import express, { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env';
import { BulkCampaign, BulkCampaignRecipient } from '../../database/models/bulk-campaign.model';
import { Conversation } from '../../database/models/conversation.model';
import { Customer } from '../../database/models/customer.model';
import { authenticate, requireRoles, type AuthenticatedRequest } from '../../middleware/auth';
import { recordActivity } from '../logs/activity-log';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 500;
const MAX_IMPORT_ROWS = 5000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const mediaTypes: Record<string, { type: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; mimeType: string }> = {
  '.jpg': { type: 'IMAGE', mimeType: 'image/jpeg' },
  '.jpeg': { type: 'IMAGE', mimeType: 'image/jpeg' },
  '.png': { type: 'IMAGE', mimeType: 'image/png' },
  '.mp4': { type: 'VIDEO', mimeType: 'video/mp4' },
  '.pdf': { type: 'DOCUMENT', mimeType: 'application/pdf' },
  '.doc': { type: 'DOCUMENT', mimeType: 'application/msword' },
  '.docx': { type: 'DOCUMENT', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xls': { type: 'DOCUMENT', mimeType: 'application/vnd.ms-excel' },
  '.xlsx': { type: 'DOCUMENT', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.ppt': { type: 'DOCUMENT', mimeType: 'application/vnd.ms-powerpoint' },
  '.pptx': { type: 'DOCUMENT', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.txt': { type: 'DOCUMENT', mimeType: 'text/plain' },
};

const campaignInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  message: z.string().trim().max(4096).default(''),
  attachment: z
    .object({
      type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
      url: z.string().url(),
      filename: z.string().trim().min(1).max(180),
      mimeType: z.string().trim().min(1).max(120),
    })
    .optional(),
});

const campaignPageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const recipientStatusSchema = z.enum(['UNSENT', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED']);

type ParsedRow = { rowNumber: number; raw: string };
type RecipientInput = {
  campaignId: Types.ObjectId;
  recipientKey: string;
  phoneNumber: string;
  customerId?: Types.ObjectId;
  sourceRow: number;
  eligible: boolean;
  status: 'UNSENT';
  reason?: string;
};

function normalizePhone(raw: string): string | undefined {
  let digits = raw.trim().replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10) digits = `91${digits}`;
  else if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  if (digits.length < 11 || digits.length > 15 || digits.startsWith('0')) return undefined;
  return digits;
}

function spreadsheetCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if ('formula' in value || 'sharedFormula' in value) return '';
  if ('richText' in value) return value.richText.map((item) => item.text).join('');
  if ('text' in value && typeof value.text === 'string') return value.text;
  return '';
}

function readRowsFromSheet(sheet: ExcelJS.Worksheet): ParsedRow[] {
  if (sheet.rowCount > MAX_IMPORT_ROWS + 1) {
    throw new ApiError(413, `A spreadsheet may contain at most ${MAX_IMPORT_ROWS} populated recipient rows`, 'IMPORT_TOO_LARGE');
  }
  const headerRow = sheet.getRow(1);
  const headerNames = ['phone', 'mobile', 'whatsapp', 'telephone', 'contact'];
  let phoneColumn = 1;
  let hasHeader = false;
  headerRow.eachCell({ includeEmpty: false }, (cell, column) => {
    const header = spreadsheetCellText(cell).toLowerCase().replace(/[^a-z]/g, '');
    if (headerNames.some((name) => header.includes(name))) {
      phoneColumn = column;
      hasHeader = true;
    }
  });
  const firstRow = hasHeader ? 2 : 1;
  const rows: ParsedRow[] = [];
  for (let rowNumber = firstRow; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const raw = spreadsheetCellText(sheet.getRow(rowNumber).getCell(phoneColumn)).trim();
    if (raw) rows.push({ rowNumber, raw });
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ApiError(413, `A spreadsheet may contain at most ${MAX_IMPORT_ROWS} populated recipient rows`, 'IMPORT_TOO_LARGE');
    }
  }
  return rows;
}

async function parseImport(buffer: Buffer, contentType: string | undefined): Promise<ParsedRow[]> {
  if (!buffer.length) throw new ApiError(400, 'The uploaded recipient file is empty', 'EMPTY_IMPORT');
  const workbook = new ExcelJS.Workbook();
  try {
    if (contentType === 'text/csv' || contentType === 'application/csv') {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      await workbook.csv.read(Readable.from([buffer]));
    } else if (
      contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      contentType === 'application/octet-stream'
    ) {
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        throw new ApiError(400, 'The file is not a valid .xlsx workbook', 'INVALID_IMPORT_FILE');
      }
      await workbook.xlsx.load(buffer);
    } else {
      throw new ApiError(415, 'Upload a .csv or .xlsx recipient file', 'UNSUPPORTED_IMPORT_TYPE');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'The recipient file could not be read; check that it is a valid CSV or XLSX file', 'INVALID_IMPORT_FILE');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ApiError(400, 'The recipient file has no worksheet', 'INVALID_IMPORT_FILE');
  const rows = readRowsFromSheet(sheet);
  if (!rows.length) throw new ApiError(400, 'No phone numbers were found in the first phone column', 'EMPTY_IMPORT');
  return rows;
}

async function assessRecipients(campaignId: Types.ObjectId, rows: ParsedRow[]): Promise<{
  recipients: RecipientInput[];
  duplicates: number;
  eligible: number;
}> {
  const uniqueNumbers = new Map<string, ParsedRow>();
  const invalidRows: ParsedRow[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const normalized = normalizePhone(row.raw);
    if (!normalized) {
      invalidRows.push(row);
      continue;
    }
    if (uniqueNumbers.has(normalized)) {
      duplicates += 1;
      continue;
    }
    uniqueNumbers.set(normalized, row);
  }
  if (uniqueNumbers.size > MAX_RECIPIENTS) {
    throw new ApiError(413, `A campaign may include at most ${MAX_RECIPIENTS} unique recipients`, 'TOO_MANY_RECIPIENTS');
  }

  const phoneCandidates = new Set<string>();
  for (const number of uniqueNumbers.keys()) {
    phoneCandidates.add(number);
    phoneCandidates.add(`+${number}`);
    if (number.startsWith('91')) {
      const localNumber = number.slice(2);
      phoneCandidates.add(localNumber);
      phoneCandidates.add(`+${localNumber}`);
      phoneCandidates.add(`0${localNumber}`);
    }
  }
  const customers = phoneCandidates.size
    ? await Customer.find({
        $or: [
          { whatsappId: { $in: [...phoneCandidates] } },
          { phoneNumber: { $in: [...phoneCandidates] } },
        ],
      })
        .select('_id whatsappId phoneNumber optInStatus')
        .lean()
    : [];
  const customersByNumber = new Map<string, typeof customers>();
  for (const customer of customers) {
    const keys = new Set([normalizePhone(customer.whatsappId), normalizePhone(customer.phoneNumber ?? '')]);
    for (const key of keys) {
      if (!key) continue;
      const current = customersByNumber.get(key) ?? [];
      if (!current.some((item) => String(item._id) === String(customer._id))) current.push(customer);
      customersByNumber.set(key, current);
    }
  }

  const customerIds = customers.map((customer) => customer._id);
  const conversations = customerIds.length
    ? await Conversation.find({
        customerId: { $in: customerIds },
        status: { $in: ['OPEN', 'HUMAN_HANDOVER'] },
        lastInteractionAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      })
        .select('customerId')
        .lean()
    : [];
  const activeCustomerIds = new Set(conversations.map((conversation) => String(conversation.customerId)));

  const recipients: RecipientInput[] = [];
  let eligible = 0;
  for (const [number, row] of uniqueNumbers) {
    const matches = customersByNumber.get(number) ?? [];
    const customer = matches.length === 1 ? matches[0] : undefined;
    let reason: string | undefined;
    if (matches.length > 1) reason = 'This phone number matches multiple customer records';
    else if (!customer) reason = 'No customer record matches this number';
    else if (customer.optInStatus === 'OPTED_OUT') reason = 'Customer has opted out of business messages';
    else if (customer.optInStatus !== 'OPTED_IN') reason = 'Customer consent is not recorded as opted in';
    else if (!activeCustomerIds.has(String(customer._id))) {
      reason = '24-hour service window expired; an approved template flow is required';
    }
    const canSend = !reason && Boolean(customer);
    if (canSend) eligible += 1;
    recipients.push({
      campaignId,
      recipientKey: number,
      phoneNumber: number,
      ...(customer ? { customerId: customer._id } : {}),
      sourceRow: row.rowNumber,
      eligible: canSend,
      status: 'UNSENT',
      ...(reason ? { reason } : {}),
    });
  }
  for (const row of invalidRows) {
    recipients.push({
      campaignId,
      recipientKey: `invalid:${row.rowNumber}`,
      phoneNumber: row.raw.slice(0, 80),
      sourceRow: row.rowNumber,
      eligible: false,
      status: 'UNSENT',
      reason: 'Invalid phone number; use 10-digit Indian numbers or an international number with country code',
    });
  }
  return { recipients, duplicates, eligible };
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function campaignStatusCounts(campaignId: Types.ObjectId): Promise<Record<string, number>> {
  const groups = await BulkCampaignRecipient.aggregate<{ _id: string; count: number }>([
    { $match: { campaignId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(groups.map((group) => [group._id, group.count]));
}

function campaignIdOrThrow(id: unknown): Types.ObjectId {
  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) {
    throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');
  }
  return new Types.ObjectId(id);
}

function uploadedBuffer(request: Request): Buffer {
  if (!Buffer.isBuffer(request.body)) throw new ApiError(400, 'Upload a recipient file', 'EMPTY_IMPORT');
  return request.body;
}

function safeMediaName(request: Request): { original: string; extension: string } {
  const raw = request.header('x-file-name') ?? '';
  const original = basename(raw).replace(/[^\w.-]/g, '_').slice(-180);
  const extension = extname(original).toLowerCase();
  if (!original || !mediaTypes[extension]) {
    throw new ApiError(415, 'Unsupported attachment. Use JPG, PNG, MP4, PDF, Office documents, or TXT', 'UNSUPPORTED_MEDIA_TYPE');
  }
  return { original, extension };
}

function validateMediaContent(buffer: Buffer, extension: string): void {
  const startsWith = (bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);
  if (['.jpg', '.jpeg'].includes(extension) && !startsWith([0xff, 0xd8, 0xff])) {
    throw new ApiError(400, 'The image file does not match its extension', 'INVALID_MEDIA_FILE');
  }
  if (extension === '.png' && !startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    throw new ApiError(400, 'The image file does not match its extension', 'INVALID_MEDIA_FILE');
  }
  if (extension === '.mp4' && buffer.toString('ascii', 4, 8) !== 'ftyp') {
    throw new ApiError(400, 'The video file does not match its extension', 'INVALID_MEDIA_FILE');
  }
  if (extension === '.pdf' && buffer.toString('ascii', 0, 5) !== '%PDF-') {
    throw new ApiError(400, 'The document file does not match its extension', 'INVALID_MEDIA_FILE');
  }
  const officeExtensions = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
  if (officeExtensions.includes(extension)) {
    const isLegacyOffice = startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const isOpenXml = startsWith([0x50, 0x4b, 0x03, 0x04]);
    if ((extension.endsWith('x') && !isOpenXml) || (!extension.endsWith('x') && !isLegacyOffice)) {
      throw new ApiError(400, 'The document file does not match its extension', 'INVALID_MEDIA_FILE');
    }
  }
  if (extension === '.txt') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new ApiError(400, 'The text document must use UTF-8 encoding', 'INVALID_MEDIA_FILE');
    }
    if (buffer.includes(0)) throw new ApiError(400, 'The text document contains invalid binary data', 'INVALID_MEDIA_FILE');
  }
}

export const bulkCampaignsRouter = Router();
const adminOnly = [authenticate, requireRoles('ADMIN')] as const;

bulkCampaignsRouter.get(
  '/sample.csv',
  ...adminOnly,
  (_req, res) => {
    res
      .type('text/csv')
      .setHeader('Content-Disposition', 'attachment; filename="ncut-whatsapp-contacts-sample.csv"')
      .send('Phone Number\r\n');
  },
);

bulkCampaignsRouter.get(
  '/sample.xlsx',
  ...adminOnly,
  asyncHandler(async (_req, res) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('WhatsApp Contacts');
    sheet.columns = [{ header: 'Phone Number', key: 'phoneNumber', width: 24 }];
    sheet.getRow(1).font = { bold: true };
    const bytes = await workbook.xlsx.writeBuffer();
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('Content-Disposition', 'attachment; filename="ncut-whatsapp-contacts-sample.xlsx"')
      .send(Buffer.from(bytes));
  }),
);

bulkCampaignsRouter.post(
  '/media',
  ...adminOnly,
  express.raw({ type: () => true, limit: MAX_MEDIA_BYTES }),
  asyncHandler(async (req, res) => {
    const buffer = uploadedBuffer(req);
    if (!buffer.length) throw new ApiError(400, 'The attachment is empty', 'EMPTY_MEDIA_FILE');
    const { original, extension } = safeMediaName(req);
    const type = mediaTypes[extension];
    if (!type) throw new ApiError(415, 'Unsupported attachment type', 'UNSUPPORTED_MEDIA_TYPE');
    if (buffer.length > MAX_MEDIA_BYTES) throw new ApiError(413, 'Attachment must be 20 MB or smaller', 'MEDIA_TOO_LARGE');
    if (buffer.length > (type.type === 'IMAGE' ? 5 * 1024 * 1024 : type.type === 'VIDEO' ? 16 * 1024 * 1024 : MAX_MEDIA_BYTES)) {
      throw new ApiError(413, 'Image attachments are limited to 5 MB and video attachments to 16 MB', 'MEDIA_TOO_LARGE');
    }
    const contentType = req.header('content-type')?.split(';')[0]?.trim();
    if (contentType !== type.mimeType && contentType !== 'application/octet-stream') {
      throw new ApiError(415, 'The attachment MIME type does not match its file extension', 'UNSUPPORTED_MEDIA_TYPE');
    }
    validateMediaContent(buffer, extension);
    const storedName = `${randomUUID()}${extension}`;
    const directory = resolve(process.cwd(), 'uploads', 'campaigns');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, storedName), buffer, { flag: 'wx' });
    res.status(201).json({
      success: true,
      data: {
        type: type.type,
        mimeType: type.mimeType,
        filename: original,
        url: new URL(`/uploads/campaigns/${storedName}`, env.APP_URL).toString(),
      },
    });
  }),
);

bulkCampaignsRouter.post(
  '/',
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const input = campaignInputSchema.parse(req.body);
    if (!input.message && !input.attachment) {
      throw new ApiError(400, 'Add a message or an attachment before creating a campaign', 'CAMPAIGN_CONTENT_REQUIRED');
    }
    if (input.attachment && input.message.length > 1024) {
      throw new ApiError(400, 'Message captions with attachments may not exceed 1,024 characters', 'CAPTION_TOO_LONG');
    }
    if (input.attachment) {
      const assetUrl = new URL(input.attachment.url);
      const appUrl = new URL(env.APP_URL);
      const extension = extname(assetUrl.pathname).toLowerCase();
      const expected = mediaTypes[extension];
      if (
        assetUrl.origin !== appUrl.origin ||
        !assetUrl.pathname.startsWith('/uploads/campaigns/') ||
        !expected ||
        expected.type !== input.attachment.type ||
        expected.mimeType !== input.attachment.mimeType ||
        !/^[\da-f-]{36}\.[a-z0-9]+$/i.test(basename(assetUrl.pathname))
      ) {
        throw new ApiError(400, 'Upload the attachment through this campaign before creating it', 'INVALID_CAMPAIGN_ATTACHMENT');
      }
    }
    const campaign = await BulkCampaign.create({
      ...input,
      createdBy: (req as AuthenticatedRequest).user?.id,
    });
    await recordActivity({
      source: 'USER',
      action: 'BULK_CAMPAIGN_CREATED',
      summary: `Created bulk campaign "${campaign.name}"`,
      resourceType: 'bulk-campaign',
      resourceId: campaign.id,
      actorId: (req as AuthenticatedRequest).user?.id,
      actorRole: 'ADMIN',
    });
    res.status(201).json({ success: true, data: campaign });
  }),
);

bulkCampaignsRouter.post(
  '/:id/import',
  ...adminOnly,
  express.raw({
    type: [
      'text/csv',
      'application/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
    ],
    limit: MAX_IMPORT_BYTES,
  }),
  asyncHandler(async (req, res) => {
    const campaignId = campaignIdOrThrow(req.params.id);
    const campaign = await BulkCampaign.findById(campaignId);
    if (!campaign) throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');
    if (campaign.status !== 'DRAFT') throw new ApiError(409, 'Recipients can only be imported into a draft campaign', 'CAMPAIGN_NOT_DRAFT');
    if (await BulkCampaignRecipient.exists({ campaignId })) {
      throw new ApiError(409, 'This campaign already has an imported recipient list', 'RECIPIENTS_ALREADY_IMPORTED');
    }
    const buffer = uploadedBuffer(req);
    const rows = await parseImport(buffer, req.header('content-type')?.split(';')[0]?.trim());
    const { recipients, duplicates, eligible } = await assessRecipients(campaignId, rows);
    await BulkCampaignRecipient.insertMany(recipients, { ordered: true });
    campaign.inputRows = rows.length;
    campaign.duplicateRows = duplicates;
    campaign.eligibleRecipients = eligible;
    campaign.status = 'READY';
    await campaign.save();
    await recordActivity({
      source: 'USER',
      action: 'BULK_CAMPAIGN_RECIPIENTS_IMPORTED',
      summary: `Imported ${rows.length} rows into "${campaign.name}" (${eligible} eligible, ${duplicates} duplicates skipped)`,
      resourceType: 'bulk-campaign',
      resourceId: campaign.id,
      actorId: (req as AuthenticatedRequest).user?.id,
      actorRole: 'ADMIN',
    });
    res.status(200).json({
      success: true,
      data: {
        campaign,
        rows: rows.length,
        uniqueRecipients: recipients.length,
        duplicateRows: duplicates,
        eligible,
        unsent: recipients.length - eligible,
      },
    });
  }),
);

bulkCampaignsRouter.get(
  '/',
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const { page, limit } = campaignPageSchema.parse(req.query);
    const [items, total] = await Promise.all([
      BulkCampaign.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      BulkCampaign.countDocuments(),
    ]);
    const grouped = items.length
      ? await BulkCampaignRecipient.aggregate<{ _id: { campaignId: Types.ObjectId; status: string }; count: number }>([
          { $match: { campaignId: { $in: items.map((item) => item._id) } } },
          { $group: { _id: { campaignId: '$campaignId', status: '$status' }, count: { $sum: 1 } } },
        ])
      : [];
    const counts = new Map<string, Record<string, number>>();
    for (const group of grouped) {
      const id = String(group._id.campaignId);
      const row = counts.get(id) ?? {};
      row[group._id.status] = group.count;
      counts.set(id, row);
    }
    res.json({
      success: true,
      data: {
        items: items.map((item) => ({ ...item, recipientCounts: counts.get(String(item._id)) ?? {} })),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  }),
);

bulkCampaignsRouter.get(
  '/:id/export.csv',
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const campaignId = campaignIdOrThrow(req.params.id);
    const status = req.query.status ? recipientStatusSchema.parse(req.query.status) : undefined;
    const filter = { campaignId, ...(status ? { status } : {}) };
    const recipients = await BulkCampaignRecipient.find(filter).sort({ sourceRow: 1 }).lean();
    const header = ['Source row', 'Phone number', 'Status', 'Eligible', 'Reason', 'Attempts', 'Sent at', 'Delivered at', 'Read at', 'Last error'];
    const rows = recipients.map((recipient) =>
      [
        recipient.sourceRow,
        recipient.phoneNumber,
        recipient.status,
        recipient.eligible ? 'Yes' : 'No',
        recipient.reason,
        recipient.attempts,
        recipient.sentAt?.toISOString(),
        recipient.deliveredAt?.toISOString(),
        recipient.readAt?.toISOString(),
        recipient.lastError,
      ]
        .map(csvCell)
        .join(','),
    );
    res
      .type('text/csv')
      .setHeader('Content-Disposition', `attachment; filename="campaign-${campaignId}-recipients.csv"`)
      .send([header.map(csvCell).join(','), ...rows].join('\r\n'));
  }),
);

bulkCampaignsRouter.get(
  '/:id',
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const campaignId = campaignIdOrThrow(req.params.id);
    const campaign = await BulkCampaign.findById(campaignId).lean();
    if (!campaign) throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');
    const { page, limit } = campaignPageSchema.parse(req.query);
    const status = req.query.status ? recipientStatusSchema.parse(req.query.status) : undefined;
    const filter = { campaignId, ...(status ? { status } : {}) };
    const [items, total, statusCounts] = await Promise.all([
      BulkCampaignRecipient.find(filter)
        .populate('customerId', 'name profileName phoneNumber')
        .sort({ sourceRow: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      BulkCampaignRecipient.countDocuments(filter),
      campaignStatusCounts(campaignId),
    ]);
    res.json({
      success: true,
      data: { campaign, recipients: { items, total, page, limit, pages: Math.ceil(total / limit) }, statusCounts },
    });
  }),
);

bulkCampaignsRouter.post(
  '/:id/send',
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const campaignId = campaignIdOrThrow(req.params.id);
    const campaign = await BulkCampaign.findById(campaignId);
    if (!campaign) throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');
    if (campaign.status !== 'READY') throw new ApiError(409, 'Only a previewed campaign can be sent', 'CAMPAIGN_NOT_READY');
    if (campaign.eligibleRecipients < 1) {
      throw new ApiError(409, 'There are no opted-in recipients with an open 24-hour service window', 'NO_ELIGIBLE_RECIPIENTS');
    }
    await BulkCampaignRecipient.updateMany(
      { campaignId, eligible: true, status: 'UNSENT' },
      { $set: { status: 'QUEUED' } },
    );
    campaign.status = 'QUEUED';
    campaign.startedAt = new Date();
    await campaign.save();
    await recordActivity({
      source: 'USER',
      action: 'BULK_CAMPAIGN_QUEUED',
      summary: `Queued "${campaign.name}" for ${campaign.eligibleRecipients} eligible recipients`,
      resourceType: 'bulk-campaign',
      resourceId: campaign.id,
      actorId: (req as AuthenticatedRequest).user?.id,
      actorRole: 'ADMIN',
    });
    res.status(202).json({ success: true, data: { campaign, queued: campaign.eligibleRecipients } });
  }),
);

