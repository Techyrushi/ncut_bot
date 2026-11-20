import { model, Schema, type InferSchemaType } from 'mongoose';

const campaignAttachmentSchema = new Schema(
  {
    type: { type: String, enum: ['IMAGE', 'VIDEO', 'DOCUMENT'], required: true },
    url: { type: String, required: true },
    filename: { type: String, required: true, maxlength: 180 },
    mimeType: { type: String, required: true, maxlength: 120 },
  },
  { _id: false },
);

const bulkCampaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, trim: true, maxlength: 4096, default: '' },
    attachment: { type: campaignAttachmentSchema },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['DRAFT', 'READY', 'QUEUED', 'PROCESSING', 'COMPLETED', 'CANCELLED'],
      default: 'DRAFT',
      index: true,
    },
    inputRows: { type: Number, default: 0 },
    duplicateRows: { type: Number, default: 0 },
    eligibleRecipients: { type: Number, default: 0 },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

bulkCampaignSchema.index({ status: 1, createdAt: 1 });

const campaignRecipientSchema = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'BulkCampaign', required: true, index: true },
    recipientKey: { type: String, required: true },
    phoneNumber: { type: String, required: true, maxlength: 80 },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    sourceRow: { type: Number, required: true },
    eligible: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['UNSENT', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'],
      default: 'UNSENT',
      index: true,
    },
    reason: { type: String, maxlength: 240 },
    lastError: { type: String, maxlength: 500 },
    attempts: { type: Number, default: 0 },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    whatsappMessageId: { type: String, sparse: true, unique: true },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
    readAt: { type: Date },
  },
  { timestamps: true },
);

campaignRecipientSchema.index({ campaignId: 1, recipientKey: 1 }, { unique: true });
campaignRecipientSchema.index({ campaignId: 1, status: 1, sourceRow: 1 });

export type BulkCampaignDocument = InferSchemaType<typeof bulkCampaignSchema>;
export type BulkCampaignRecipientDocument = InferSchemaType<typeof campaignRecipientSchema>;
export const BulkCampaign = model('BulkCampaign', bulkCampaignSchema);
export const BulkCampaignRecipient = model('BulkCampaignRecipient', campaignRecipientSchema);
