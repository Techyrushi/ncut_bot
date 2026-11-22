import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import express, { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { BulkCampaignRecipient } from '../../database/models/bulk-campaign.model';
import { Customer, normalizePhoneIdentity } from '../../database/models/customer.model';
import { Conversation } from '../../database/models/conversation.model';
import { Lead } from '../../database/models/lead.model';
import { Message } from '../../database/models/message.model';
import { authenticate, requireRoles, type AuthenticatedRequest } from '../../middleware/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ApiError } from '../../utils/api-error';
import { recordActivity } from '../logs/activity-log';

export const customersRouter = Router();
const MAX_CONSENT_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_CONSENT_IMPORT_ROWS = 500;
const MAX_CONSENT_IMPORT_SHEET_ROWS = 5000;

type ConsentImportRow = {
  rowNumber: number;
  phoneNumber: string;
  name?: string;
  consentAt?: Date;
  consentSource: string;
};

type ParsedConsentImport = {
  rows: ConsentImportRow[];
  inputRows: number;
  duplicateRows: number;
};

function importCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null || typeof value === 'boolean' || value instanceof Date) return '';
  if (typeof value === 'number' || typeof value === 'string') return String(value).trim();
  if ('formula' in value || 'sharedFormula' in value) return '';
  if ('richText' in value) return value.richText.map((item) => item.text).join('').trim();
  if ('text' in value && typeof value.text === 'string') return value.text.trim();
  return '';
}

function normalizeImportedPhone(raw: string): string | undefined {
  let digits = raw.trim().replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10) digits = `91${digits}`;
  else if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  if (digits.length < 11 || digits.length > 15 || digits.startsWith('0')) return undefined;
  return digits;
}

function phoneCandidates(phoneNumber: string): string[] {
  const candidates = new Set([phoneNumber, `+${phoneNumber}`]);
  if (phoneNumber.startsWith('91')) {
    const localNumber = phoneNumber.slice(2);
    candidates.add(localNumber);
    candidates.add(`+${localNumber}`);
    candidates.add(`0${localNumber}`);
  }
  return [...candidates];
}

async function parseConsentImport(buffer: Buffer, contentType: string | undefined): Promise<ParsedConsentImport> {
  if (!buffer.length) throw new ApiError(400, 'The consent spreadsheet is empty', 'EMPTY_IMPORT');
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
      throw new ApiError(415, 'Upload a .csv or .xlsx consent spreadsheet', 'UNSUPPORTED_IMPORT_TYPE');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'The consent spreadsheet could not be read; check that it is a valid CSV or XLSX file', 'INVALID_IMPORT_FILE');
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ApiError(400, 'The consent spreadsheet has no worksheet', 'INVALID_IMPORT_FILE');
  if (sheet.rowCount > MAX_CONSENT_IMPORT_SHEET_ROWS + 1) {
    throw new ApiError(413, 'A consent spreadsheet may contain at most 5,000 rows', 'IMPORT_TOO_LARGE');
  }
  const columns: Record<string, number> = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => {
    const header = importCellText(cell).toLowerCase().replace(/[^a-z]/g, '');
    if (['phone', 'phonenumber', 'mobile', 'mobilenumber', 'whatsapp', 'whatsappnumber', 'telephone', 'contact'].includes(header)) {
      columns.phone ??= column;
    } else if (['name', 'customername', 'contactname'].includes(header)) {
      columns.name ??= column;
    } else if (['consentstatus', 'optinstatus'].includes(header)) {
      columns.status ??= column;
    } else if (['consentdate', 'optindate'].includes(header)) {
      columns.date ??= column;
    } else if (['consentsource', 'optinsource'].includes(header)) {
      columns.source ??= column;
    }
  });
  if (!columns.phone || !columns.status || !columns.source) {
    throw new ApiError(
      400,
      'Required headers: Phone Number, Consent Status, and Consent Source. Customer Name and Consent Date are optional.',
      'INVALID_CONSENT_IMPORT_HEADERS',
    );
  }

  const rows: ConsentImportRow[] = [];
  const seenNumbers = new Set<string>();
  let duplicateRows = 0;
  let inputRows = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const rawPhone = importCellText(row.getCell(columns.phone));
    const rawStatus = importCellText(row.getCell(columns.status)).toUpperCase().replace(/[\s-]+/g, '_');
    const rawDateCell = columns.date ? row.getCell(columns.date).value : undefined;
    const rawDate = columns.date ? importCellText(row.getCell(columns.date)) : '';
    const consentSource = importCellText(row.getCell(columns.source));
    const name = columns.name ? importCellText(row.getCell(columns.name)) : '';
    if (![rawPhone, rawStatus, rawDate, consentSource, name].some(Boolean)) continue;
    inputRows += 1;
    if (inputRows > MAX_CONSENT_IMPORT_ROWS) {
      throw new ApiError(413, `A consent spreadsheet may contain at most ${MAX_CONSENT_IMPORT_ROWS} contacts`, 'IMPORT_TOO_LARGE');
    }
    if (!rawPhone) throw new ApiError(400, `Row ${rowNumber}: Phone Number is required`, 'INVALID_CONSENT_IMPORT_ROW');
    const phoneNumber = normalizeImportedPhone(rawPhone);
    if (!phoneNumber) throw new ApiError(400, `Row ${rowNumber}: Phone Number is invalid`, 'INVALID_CONSENT_IMPORT_ROW');
    if (rawStatus !== 'OPTED_IN') {
      throw new ApiError(400, `Row ${rowNumber}: Consent Status must be OPTED_IN`, 'INVALID_CONSENT_IMPORT_ROW');
    }
    if (!consentSource || consentSource.length > 450) {
      throw new ApiError(400, `Row ${rowNumber}: Consent Source is required and must be at most 450 characters`, 'INVALID_CONSENT_IMPORT_ROW');
    }
    if (name.length > 120) {
      throw new ApiError(400, `Row ${rowNumber}: Customer Name must be at most 120 characters`, 'INVALID_CONSENT_IMPORT_ROW');
    }
    const consentAt = rawDateCell instanceof Date
      ? rawDateCell
      : rawDate
        ? /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(rawDate)
          ? new Date(rawDate)
          : new Date(Number.NaN)
        : undefined;
    if (consentAt && (Number.isNaN(consentAt.getTime()) || consentAt.getTime() > Date.now())) {
      throw new ApiError(400, `Row ${rowNumber}: Consent Date must be a valid ISO date/time that is not in the future`, 'INVALID_CONSENT_IMPORT_ROW');
    }
    if (seenNumbers.has(phoneNumber)) {
      duplicateRows += 1;
      continue;
    }
    seenNumbers.add(phoneNumber);
    rows.push({
      rowNumber,
      phoneNumber,
      ...(name ? { name } : {}),
      ...(consentAt ? { consentAt } : {}),
      consentSource,
    });
  }
  if (!rows.length) throw new ApiError(400, 'No valid opted-in contacts were found', 'EMPTY_IMPORT');
  if (rows.length > MAX_CONSENT_IMPORT_ROWS) {
    throw new ApiError(413, `A consent spreadsheet may contain at most ${MAX_CONSENT_IMPORT_ROWS} unique contacts`, 'IMPORT_TOO_LARGE');
  }
  return { rows, inputRows, duplicateRows };
}

customersRouter.get(
  '/',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const optInStatus = z.enum(['UNKNOWN', 'OPTED_IN', 'OPTED_OUT']).optional().parse(req.query.optInStatus);
    const filter = {
      ...(optInStatus ? { optInStatus } : {}),
      ...(search
        ? {
          $or: [
            { phoneNumber: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { whatsappId: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { profileName: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          ],
        }
        : {}),
    };
    const [items, total] = await Promise.all([
      Customer.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Customer.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, page, limit, total } });
  }),
);

customersRouter.get(
  '/import-sample.xlsx',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (_req, res) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Consented Contacts');
    sheet.columns = [
      { header: 'Phone Number', key: 'phoneNumber', width: 22 },
      { header: 'Customer Name', key: 'name', width: 24 },
      { header: 'Consent Status', key: 'consentStatus', width: 18 },
      { header: 'Consent Date', key: 'consentDate', width: 24 },
      { header: 'Consent Source', key: 'consentSource', width: 36 },
    ];
    sheet.getRow(1).font = { bold: true };
    const bytes = await workbook.xlsx.writeBuffer();
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('Content-Disposition', 'attachment; filename="ncut-consented-contacts-sample.xlsx"')
      .send(Buffer.from(bytes));
  }),
);

customersRouter.post(
  '/import',
  authenticate,
  requireRoles('ADMIN'),
  express.raw({
    type: ['text/csv', 'application/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
    limit: MAX_CONSENT_IMPORT_BYTES,
  }),
  asyncHandler(async (req, res) => {
    if (req.header('x-consent-verified') !== 'true') {
      throw new ApiError(400, 'Confirm that every imported contact explicitly opted in before importing', 'CONSENT_CONFIRMATION_REQUIRED');
    }
    if (!Buffer.isBuffer(req.body)) throw new ApiError(400, 'Upload a consent spreadsheet', 'EMPTY_IMPORT');
    const contentType = req.header('content-type')?.split(';')[0]?.trim();
    const { rows, inputRows, duplicateRows } = await parseConsentImport(req.body, contentType);
    const candidates = [...new Set(rows.flatMap((row) => phoneCandidates(row.phoneNumber)))];
    const existing = await Customer.find({
      $or: [{ whatsappId: { $in: candidates } }, { phoneNumber: { $in: candidates } }],
    })
      .select('_id whatsappId phoneNumber optInStatus optInAt')
      .lean();
    const byNumber = new Map<string, typeof existing>();
    for (const customer of existing) {
      const keys = new Set([
        normalizeImportedPhone(customer.whatsappId),
        normalizeImportedPhone(customer.phoneNumber ?? ''),
      ]);
      for (const key of keys) {
        if (!key) continue;
        const matches = byNumber.get(key) ?? [];
        matches.push(customer);
        byNumber.set(key, matches);
      }
    }

    const operations: Parameters<typeof Customer.bulkWrite>[0] = [];
    let created = 0;
    let updated = 0;
    let skippedOptedOut = 0;
    let skippedAlreadyOptedIn = 0;
    let skippedAmbiguous = 0;
    for (const row of rows) {
      const matches = byNumber.get(row.phoneNumber) ?? [];
      if (matches.length > 1) {
        skippedAmbiguous += 1;
        continue;
      }
      const customer = matches[0];
      if (customer?.optInStatus === 'OPTED_OUT') {
        skippedOptedOut += 1;
        continue;
      }
      if (customer?.optInStatus === 'OPTED_IN') {
        skippedAlreadyOptedIn += 1;
        continue;
      }
      if (customer) {
        operations.push({
          updateOne: {
            filter: { _id: customer._id },
            update: {
              $set: {
                phoneNumber: row.phoneNumber,
                phoneIdentity: normalizePhoneIdentity(row.phoneNumber),
                ...(row.name ? { name: row.name } : {}),
                optInStatus: 'OPTED_IN',
                ...(row.consentAt ? { optInAt: row.consentAt } : {}),
                optInSource: row.consentSource,
              },
              ...(!row.consentAt ? { $unset: { optInAt: 1 } } : {}),
            },
          },
        });
        updated += 1;
      } else {
        operations.push({
          insertOne: {
            document: {
              whatsappId: row.phoneNumber,
              phoneNumber: row.phoneNumber,
              phoneIdentity: normalizePhoneIdentity(row.phoneNumber),
              ...(row.name ? { name: row.name } : {}),
              optInStatus: 'OPTED_IN',
              ...(row.consentAt ? { optInAt: row.consentAt } : {}),
              optInSource: row.consentSource,
            },
          },
        });
        created += 1;
      }
    }
    if (operations.length) await Customer.bulkWrite(operations);
    const user = (req as AuthenticatedRequest).user;
    await recordActivity({
      source: 'USER',
      action: 'CUSTOMER_CONSENT_IMPORT',
      summary: `Imported ${created} new and updated ${updated} customer consent record(s); skipped ${skippedAlreadyOptedIn} already opted-in, ${skippedAmbiguous} ambiguous, and preserved ${skippedOptedOut} opted-out contact(s)`,
      resourceType: 'customer',
      actorId: user?.id,
      actorRole: user?.role,
    });
    res.status(200).json({
      success: true,
      data: {
        rows: inputRows,
        uniqueContacts: rows.length,
        duplicateRows,
        created,
        updated,
        optedIn: created + updated,
        skippedOptedOut,
        skippedAlreadyOptedIn,
        skippedAmbiguous,
      },
    });
  }),
);

customersRouter.patch(
  '/opt-in/bulk',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        ids: z
          .array(z.string().regex(/^[a-f\d]{24}$/i))
          .min(1)
          .max(100)
          .transform((ids) => [...new Set(ids)]),
        status: z.enum(['OPTED_IN', 'OPTED_OUT']),
        source: z.string().trim().min(1).max(500),
      })
      .parse(req.body);
    const filter = { _id: { $in: input.ids.map((id) => new Types.ObjectId(id)) } };
    const update =
      input.status === 'OPTED_IN'
        ? {
            $set: { optInStatus: input.status, optInAt: new Date(), optInSource: input.source },
          }
        : {
            $set: { optInStatus: input.status, optInSource: input.source },
            $unset: { optInAt: 1 },
          };
    const result = await Customer.updateMany(filter, update);
    res.json({
      success: true,
      data: { matchedCount: result.matchedCount, updatedCount: result.modifiedCount },
    });
  }),
);

customersRouter.patch(
  '/:id/opt-in',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        status: z.enum(['OPTED_IN', 'OPTED_OUT']),
        source: z.string().trim().min(1).max(500),
      })
      .parse(req.body);
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          optInStatus: input.status,
          ...(input.status === 'OPTED_IN' ? { optInAt: new Date(), optInSource: input.source } : {}),
          ...(input.status === 'OPTED_OUT' ? { optInSource: input.source } : {}),
        },
        ...(input.status === 'OPTED_OUT' ? { $unset: { optInAt: 1 } } : {}),
      },
      { new: true, runValidators: true },
    );
    if (!customer) throw new ApiError(404, 'Customer not found', 'NOT_FOUND');
    res.json({ success: true, data: customer });
  }),
);

customersRouter.delete(
  '/:id',
  authenticate,
  requireRoles('ADMIN'),
  asyncHandler(async (req, res) => {
    const customerId = req.params.id;
    if (typeof customerId !== 'string' || !Types.ObjectId.isValid(customerId)) {
      throw new ApiError(404, 'Customer not found', 'NOT_FOUND');
    }
    const customer = await Customer.findById(customerId);
    if (!customer) throw new ApiError(404, 'Customer not found', 'NOT_FOUND');

    const [conversations, messages, leads, campaignRecipients] = await Promise.all([
      Conversation.deleteMany({ customerId: customer._id }),
      Message.deleteMany({ customerId: customer._id }),
      Lead.deleteMany({ customerId: customer._id }),
      BulkCampaignRecipient.deleteMany({ customerId: customer._id }),
    ]);
    await customer.deleteOne();

    res.json({
      success: true,
      data: {
        id: customer.id,
        deleted: {
          conversations: conversations.deletedCount,
          messages: messages.deletedCount,
          leads: leads.deletedCount,
          campaignRecipients: campaignRecipients.deletedCount,
        },
      },
    });
  }),
);

customersRouter.get(
  '/:id',
  authenticate,
  requireRoles('ADMIN', 'SALES'),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id).lean();
    if (!customer) throw new ApiError(404, 'Customer not found', 'NOT_FOUND');
    res.json({ success: true, data: customer });
  }),
);
