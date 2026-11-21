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
import { MessageTemplate } from '../../database/models/message-template.model';
import { authenticate, requireRoles, type AuthenticatedRequest } from '../../middleware/auth';
import { finalizeCancelledCampaigns } from './bulk-campaign.service';
import { recordActivity } from '../logs/activity-log';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 500;
const MAX_IMPORT_ROWS = 5000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_RECIPIENT_ATTEMPTS = 2;
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
  messageTemplateId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  templateComponents: z.array(z.record(z.string(), z.unknown())).default([]),
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
const campaignListSchema = campaignPageSchema.extend({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['DRAFT', 'READY', 'QUEUED', 'PROCESSING', 'COMPLETED', 'CANCELLED']).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
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

function phoneCandidates(number: string): string[] {
  const candidates = new Set([number, `+${number}`]);
  if (number.startsWith('91')) {
    const localNumber = number.slice(2);
    candidates.add(localNumber);
    candidates.add(`+${localNumber}`);
    candidates.add(`0${localNumber}`);
  }
  return [...candidates];
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

async function assessRecipients(campaignId: Types.ObjectId, rows: ParsedRow[], hasApprovedTemplate = false): Promise<{
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

  const phoneNumberCandidates = new Set([...uniqueNumbers.keys()].flatMap(phoneCandidates));
  const customers = phoneNumberCandidates.size
    ? await Customer.find({
        $or: [
          { whatsappId: { $in: [...phoneNumberCandidates] } },
          { phoneNumber: { $in: [...phoneNumberCandidates] } },
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
    else if (!hasApprovedTemplate && !activeCustomerIds.has(String(customer._id))) {
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

type RecipientOptInResult = {
  recipientId: string;
  phoneNumber: string;
  recorded: boolean;
  eligible: boolean;
  reason: string;
};

const CONSENT_PENDING_REASONS = [
  'No customer record matches this number',
  'Customer consent is not recorded as opted in',
];

async function recordCampaignRecipientOptIn(
  campaignId: Types.ObjectId,
  recipientId: Types.ObjectId,
  consentSource: string,
  hasApprovedTemplate: boolean,
): Promise<RecipientOptInResult> {
  const recipient = await BulkCampaignRecipient.findOne({
    _id: recipientId,
    campaignId,
    status: 'UNSENT',
    eligible: false,
    reason: { $in: CONSENT_PENDING_REASONS },
  });
  if (!recipient) {
    return {
      recipientId: recipientId.toString(),
      phoneNumber: '',
      recorded: false,
      eligible: false,
      reason: 'Recipient is not an unsent consent-pending contact',
    };
  }
  const phoneNumber = normalizePhone(recipient.phoneNumber);
  if (!phoneNumber) {
    return {
      recipientId: recipientId.toString(),
      phoneNumber: recipient.phoneNumber,
      recorded: false,
      eligible: false,
      reason: 'Recipient phone number is invalid',
    };
  }

  const candidates = phoneCandidates(phoneNumber);
  const matches = await Customer.find({
    $or: [{ whatsappId: { $in: candidates } }, { phoneNumber: { $in: candidates } }],
  }).select('_id whatsappId phoneNumber optInStatus');
  const uniqueMatches = [...new Map(matches.map((customer) => [String(customer._id), customer])).values()];
  if (uniqueMatches.length > 1) {
    return {
      recipientId: recipientId.toString(),
      phoneNumber,
      recorded: false,
      eligible: false,
      reason: 'This phone number matches multiple customer records',
    };
  }
  let customer = uniqueMatches[0];
  if (customer?.optInStatus === 'OPTED_OUT') {
    return {
      recipientId: recipientId.toString(),
      phoneNumber,
      recorded: false,
      eligible: false,
      reason: 'Customer has opted out of business messages',
    };
  }
  if (customer?.optInStatus === 'OPTED_IN') {
    return {
      recipientId: recipientId.toString(),
      phoneNumber,
      recorded: false,
      eligible: false,
      reason: 'Customer is already opted in; refresh the campaign preview',
    };
  }
  if (customer) {
    customer.phoneNumber = phoneNumber;
    customer.optInStatus = 'OPTED_IN';
    customer.optInAt = new Date();
    customer.optInSource = consentSource;
    await customer.save();
  } else {
    customer = await Customer.create({
      whatsappId: phoneNumber,
      phoneNumber,
      optInStatus: 'OPTED_IN',
      optInAt: new Date(),
      optInSource: consentSource,
    });
  }

  const activeConversation = hasApprovedTemplate
    ? true
    : Boolean(
        await Conversation.exists({
          customerId: customer._id,
          status: { $in: ['OPEN', 'HUMAN_HANDOVER'] },
          lastInteractionAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        }),
      );
  const eligible = Boolean(hasApprovedTemplate || activeConversation);
  const reason = eligible ? '' : '24-hour service window expired; an approved template flow is required';
  await BulkCampaignRecipient.updateOne(
    { _id: recipient._id, campaignId, status: 'UNSENT', eligible: false },
    { $set: { customerId: customer._id, eligible, reason } },
  );
  return { recipientId: recipientId.toString(), phoneNumber, recorded: true, eligible, reason };
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
      .send('Phone Number,Example\r\nnot-a-valid-phone,Always skipped: invalid phone number\r\n');
  },
);

bulkCampaignsRouter.get(
  '/sample.xlsx',
  ...adminOnly,
  asyncHandler(async (_req, res) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('WhatsApp Contacts');
    sheet.columns = [
      { header: 'Phone Number', key: 'phoneNumber', width: 24 },
      { header: 'Example', key: 'example', width: 44 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.addRow({ phoneNumber: 'not-a-valid-phone', example: 'Always skipped: invalid phone number' });
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
    const template = input.messageTemplateId
      ? await MessageTemplate.findOne({ _id: input.messageTemplateId, metaStatus: 'APPROVED' }).lean()
      : null;
    if (input.messageTemplateId && (!template || !template.metaTemplateId)) {
      throw new ApiError(400, 'Select an approved Meta template with its Meta template ID registered', 'APPROVED_TEMPLATE_REQUIRED');
    }
    if (input.messageTemplateId && (input.attachment || input.message)) {
      throw new ApiError(400, 'Template campaigns cannot include free-form text or a separate attachment', 'INVALID_TEMPLATE_CAMPAIGN');
    }
    if (!input.messageTemplateId && !input.message && !input.attachment) {
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
      ...(input.messageTemplateId ? { messageTemplateId: input.messageTemplateId } : {}),
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
    const template = campaign.messageTemplateId
      ? await MessageTemplate.findOne({ _id: campaign.messageTemplateId, metaStatus: 'APPROVED' }).lean()
      : null;
    if (campaign.messageTemplateId && (!template || !template.metaTemplateId)) {
      throw new ApiError(409, 'The campaign template is no longer approved or has no Meta template ID', 'APPROVED_TEMPLATE_REQUIRED');
    }
    const { recipients, duplicates, eligible } = await assessRecipients(campaignId, rows, Boolean(template));
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
    const { page, limit, search, status, startDate, endDate } = campaignListSchema.parse(req.query);
    if (startDate && endDate && startDate > endDate) {
      throw new ApiError(400, 'Start date must be on or before end date', 'INVALID_DATE_RANGE');
    }
    const filter: Record<string, unknown> = { status: { $ne: 'CANCELLED' } };
    if (status) filter.status = status;
    if (search) filter.name = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (startDate || endDate) {
      filter.createdAt = {
        ...(startDate ? { $gte: new Date(`${startDate}T00:00:00.000Z`) } : {}),
        ...(endDate ? { $lte: new Date(`${endDate}T23:59:59.999Z`) } : {}),
      };
    }
    const [items, total] = await Promise.all([
      BulkCampaign.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      BulkCampaign.countDocuments(filter),
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
        .populate('customerId', 'name profileName phoneNumber optInStatus')
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
  '/:id/recipients/:recipientId/record-opt-in',
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const campaignId = campaignIdOrThrow(req.params.id);
    const recipientId = campaignIdOrThrow(req.params.recipientId);
    const input = z
      .object({
        consentSource: z.string().trim().min(1).max(500),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const campaign = await BulkCampaign.findById(campaignId);
    if (!campaign) throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');
    if (campaign.status !== 'READY') {
      throw new ApiError(409, 'Consent can only be recorded for a campaign that is ready for preview', 'CAMPAIGN_NOT_READY');
    }
    const template = campaign.messageTemplateId
      ? await MessageTemplate.findOne({ _id: campaign.messageTemplateId, metaStatus: 'APPROVED' }).lean()
      : null;
    if (campaign.messageTemplateId && (!template || !template.metaTemplateId)) {
      throw new ApiError(409, 'The campaign template is no longer approved', 'APPROVED_TEMPLATE_REQUIRED');
    }
    const result = await recordCampaignRecipientOptIn(campaignId, recipientId, input.consentSource, Boolean(template));
    if (!result.recorded) {
      throw new ApiError(
        result.reason.includes('already opted in') ? 409 : 400,
        result.reason,
        result.reason.includes('already opted in') ? 'CUSTOMER_ALREADY_OPTED_IN' : 'CONSENT_NOT_RECORDED',
      );
    }
    campaign.eligibleRecipients = await BulkCampaignRecipient.countDocuments({
      campaignId,
      status: 'UNSENT',
      eligible: true,
    });
    await campaign.save();

    const user = (req as AuthenticatedRequest).user;
    await recordActivity({
      source: 'USER',
      action: 'BULK_CAMPAIGN_RECIPIENT_OPT_IN_RECORDED',
      summary: `Recorded verified opt-in for recipient ${result.phoneNumber} in campaign "${campaign.name}"`,
      resourceType: 'bulk-campaign',
      resourceId: campaign.id,
      actorId: user?.id,
      actorRole: 'ADMIN',
    });
    res.json({
      success: true,
      data: { ...result, eligibleRecipients: campaign.eligibleRecipients },
    });
  }),
);

bulkCampaignsRouter.post(
  '/:id/recipients/record-opt-in-bulk',
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const campaignId = campaignIdOrThrow(req.params.id);
    const input = z
      .object({
        recipientIds: z
          .array(z.string().regex(/^[a-f\d]{24}$/i))
          .min(1)
          .max(100)
          .transform((ids) => [...new Set(ids)]),
        consentSource: z.string().trim().min(1).max(500),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const campaign = await BulkCampaign.findById(campaignId);
    if (!campaign) throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');
    if (campaign.status !== 'READY') {
      throw new ApiError(409, 'Consent can only be recorded for a campaign that is ready for preview', 'CAMPAIGN_NOT_READY');
    }
    const template = campaign.messageTemplateId
      ? await MessageTemplate.findOne({ _id: campaign.messageTemplateId, metaStatus: 'APPROVED' }).lean()
      : null;
    if (campaign.messageTemplateId && (!template || !template.metaTemplateId)) {
      throw new ApiError(409, 'The campaign template is no longer approved', 'APPROVED_TEMPLATE_REQUIRED');
    }

    const results: RecipientOptInResult[] = [];
    for (const id of input.recipientIds) {
      results.push(
        await recordCampaignRecipientOptIn(
          campaignId,
          new Types.ObjectId(id),
          input.consentSource,
          Boolean(template),
        ),
      );
    }
    campaign.eligibleRecipients = await BulkCampaignRecipient.countDocuments({
      campaignId,
      status: 'UNSENT',
      eligible: true,
    });
    await campaign.save();

    const recorded = results.filter((result) => result.recorded);
    const skipped = results.filter((result) => !result.recorded);
    const user = (req as AuthenticatedRequest).user;
    await recordActivity({
      source: 'USER',
      action: 'BULK_CAMPAIGN_RECIPIENT_OPT_IN_BULK_RECORDED',
      summary: `Recorded verified opt-in for ${recorded.length} recipient(s) and skipped ${skipped.length} in campaign "${campaign.name}"`,
      resourceType: 'bulk-campaign',
      resourceId: campaign.id,
      actorId: user?.id,
      actorRole: 'ADMIN',
    });
    res.json({
      success: true,
      data: {
        requested: input.recipientIds.length,
        recorded: recorded.length,
        eligible: recorded.filter((result) => result.eligible).length,
        skipped: skipped.length,
        eligibleRecipients: campaign.eligibleRecipients,
        recipients: results,
      },
    });
  }),
);

bulkCampaignsRouter.post(
  '/:id/recipients/retry-failed',
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const campaignId = campaignIdOrThrow(req.params.id);
    const input = z
      .object({
        recipientIds: z
          .array(z.string().regex(/^[a-f\d]{24}$/i))
          .min(1)
          .max(100)
          .transform((ids) => [...new Set(ids)]),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const campaign = await BulkCampaign.findById(campaignId);
    if (!campaign) throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');
    if (campaign.status !== 'COMPLETED') {
      throw new ApiError(409, 'Failed recipients can only be retried after the campaign is completed', 'CAMPAIGN_NOT_COMPLETED');
    }

    const template = campaign.messageTemplateId
      ? await MessageTemplate.findOne({ _id: campaign.messageTemplateId, metaStatus: 'APPROVED' })
          .select('_id metaTemplateId')
          .lean()
      : null;
    if (campaign.messageTemplateId && (!template || !template.metaTemplateId)) {
      throw new ApiError(409, 'The campaign template is no longer approved', 'APPROVED_TEMPLATE_REQUIRED');
    }

    const selectedRecipients = await BulkCampaignRecipient.find({
      campaignId,
      _id: { $in: input.recipientIds },
      status: 'FAILED',
      eligible: true,
      attempts: { $lt: MAX_RECIPIENT_ATTEMPTS },
      lastError: { $not: /^WhatsApp accepted the send \(/ },
    })
      .select('_id customerId lastError')
      .lean();
    const customerIds = [...new Set(selectedRecipients.flatMap((recipient) => (recipient.customerId ? [String(recipient.customerId)] : [])))];
    const optedInCustomers = await Customer.find({
      _id: { $in: customerIds },
      optInStatus: 'OPTED_IN',
    })
      .select('_id')
      .lean();
    const optedInCustomerIds = new Set(optedInCustomers.map((customer) => String(customer._id)));
    let activeConversationCustomerIds = new Set<string>();
    if (!template && customerIds.length) {
      const activeCustomers = await Conversation.distinct('customerId', {
        customerId: { $in: customerIds },
        status: { $in: ['OPEN', 'HUMAN_HANDOVER'] },
        lastInteractionAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });
      activeConversationCustomerIds = new Set(activeCustomers.map(String));
    }
    const retryableRecipients = selectedRecipients.filter(
      (recipient) =>
        recipient.customerId &&
        optedInCustomerIds.has(String(recipient.customerId)) &&
        (Boolean(template) || activeConversationCustomerIds.has(String(recipient.customerId))),
    );
    if (!retryableRecipients.length) {
      return res.json({
        success: true,
        data: { requested: input.recipientIds.length, queued: 0, skipped: input.recipientIds.length },
      });
    }

    const retryableIds = retryableRecipients.map((recipient) => recipient._id);
    const retryErrors = new Map(retryableRecipients.map((recipient) => [String(recipient._id), recipient.lastError]));
    const update = await BulkCampaignRecipient.updateMany(
      {
        campaignId,
        _id: { $in: retryableIds },
        status: 'FAILED',
        eligible: true,
        attempts: { $lt: MAX_RECIPIENT_ATTEMPTS },
      },
      { $set: { status: 'QUEUED', lastError: '' } },
    );
    const queued = update.modifiedCount;
    if (queued > 0) {
      const queuedCampaign = await BulkCampaign.findOneAndUpdate(
        { _id: campaignId, status: 'COMPLETED' },
        {
          $set: { status: 'QUEUED', eligibleRecipients: queued, startedAt: new Date() },
          $unset: { completedAt: 1 },
        },
        { new: true },
      );
      if (!queuedCampaign) {
        const currentCampaign = await BulkCampaign.findById(campaignId).select('status').lean();
        if (!currentCampaign || !['QUEUED', 'PROCESSING'].includes(currentCampaign.status)) {
          for (const [recipientId, lastError] of retryErrors) {
            await BulkCampaignRecipient.updateOne(
              { _id: recipientId, campaignId, status: 'QUEUED' },
              { $set: { status: 'FAILED', lastError: lastError ?? '' } },
            );
          }
          throw new ApiError(409, 'The campaign changed while failed recipients were being queued; refresh and try again', 'CAMPAIGN_STATE_CHANGED');
        }
      }

      const user = (req as AuthenticatedRequest).user;
      await recordActivity({
        source: 'USER',
        action: 'BULK_CAMPAIGN_FAILED_RECIPIENTS_RETRY_QUEUED',
        summary: `Queued ${queued} failed recipient(s) for a manual retry in campaign "${campaign.name}"`,
        resourceType: 'bulk-campaign',
        resourceId: campaign.id,
        actorId: user?.id,
        actorRole: 'ADMIN',
      });
    }

    res.status(202).json({
      success: true,
      data: { requested: input.recipientIds.length, queued, skipped: input.recipientIds.length - queued },
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
      throw new ApiError(409, 'There are no eligible opted-in recipients for this campaign', 'NO_ELIGIBLE_RECIPIENTS');
    }
    await BulkCampaignRecipient.updateMany(
      { campaignId, eligible: true, status: 'UNSENT' },
      { $set: { status: 'QUEUED' } },
    );
    const queuedCampaign = await BulkCampaign.findOneAndUpdate(
      { _id: campaignId, status: 'READY' },
      { $set: { status: 'QUEUED', startedAt: new Date() } },
      { new: true },
    );
    if (!queuedCampaign) {
      if (await BulkCampaign.exists({ _id: campaignId, status: 'READY' })) {
        await BulkCampaignRecipient.updateMany(
          { campaignId, status: 'QUEUED' },
          { $set: { status: 'UNSENT' } },
        );
      }
      throw new ApiError(409, 'The campaign changed while it was being queued; refresh and try again', 'CAMPAIGN_STATE_CHANGED');
    }
    await recordActivity({
      source: 'USER',
      action: 'BULK_CAMPAIGN_QUEUED',
      summary: `Queued "${queuedCampaign.name}" for ${queuedCampaign.eligibleRecipients} eligible recipients`,
      resourceType: 'bulk-campaign',
      resourceId: queuedCampaign.id,
      actorId: (req as AuthenticatedRequest).user?.id,
      actorRole: 'ADMIN',
    });
    res.status(202).json({ success: true, data: { campaign: queuedCampaign, queued: queuedCampaign.eligibleRecipients } });
  }),
);

bulkCampaignsRouter.delete(
  '/:id',
  ...adminOnly,
  asyncHandler(async (req, res) => {
    const campaignId = campaignIdOrThrow(req.params.id);
    const campaign = await BulkCampaign.findOneAndUpdate(
      { _id: campaignId, status: { $ne: 'CANCELLED' } },
      { $set: { status: 'CANCELLED' } },
      { new: true },
    );
    if (!campaign) {
      if (!(await BulkCampaign.exists({ _id: campaignId, status: 'CANCELLED' }))) {
        throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');
      }
    }

    if (campaign) {
      await recordActivity({
        source: 'USER',
        action: 'BULK_CAMPAIGN_DELETION_REQUESTED',
        summary: `Requested deletion of campaign "${campaign.name}"`,
        resourceType: 'bulk-campaign',
        resourceId: campaign.id,
        actorId: (req as AuthenticatedRequest).user?.id,
        actorRole: 'ADMIN',
      });
    }

    await finalizeCancelledCampaigns(String(campaignId));
    const deletionPending = Boolean(await BulkCampaign.exists({ _id: campaignId, status: 'CANCELLED' }));
    res.status(deletionPending ? 202 : 200).json({
      success: true,
      data: {
        id: campaignId,
        deletionPending,
        message: deletionPending
          ? 'Campaign sending was cancelled. Any send already in progress will finish before its history is removed.'
          : 'Campaign and recipient records deleted. Sent messages remain in conversation history.',
      },
    });
  }),
);

