import { model, Schema, type InferSchemaType } from 'mongoose';

const leadSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    selectedProducts: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
    assignedSalesPerson: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    status: {
      type: String,
      enum: ['NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST'],
      default: 'NEW',
      index: true,
    },
    notificationStatus: { type: String, enum: ['PENDING', 'SENT', 'FAILED'], default: 'PENDING' },
    notificationSentAt: { type: Date },
    requirement: { type: String, trim: true, maxlength: 5000 },
  },
  { timestamps: true },
);

leadSchema.index({ status: 1, createdAt: -1 });
leadSchema.index({ conversationId: 1 }, { unique: true });

export type LeadDocument = InferSchemaType<typeof leadSchema>;
export const Lead = model('Lead', leadSchema);
