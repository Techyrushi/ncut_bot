import { model, Schema, type InferSchemaType } from 'mongoose';

export const SALES_FOLLOW_UP_REQUIREMENT = 'Customer asked to connect with the sales team';

const leadSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    conversationHistory: { type: [{ type: Schema.Types.ObjectId, ref: 'Conversation' }], default: [] },
    visitHistory: {
      type: [
        new Schema(
          {
            whatsappMessageId: { type: String, required: true },
            conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
            occurredAt: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
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
    adminReadAt: { type: Date },
    requirement: { type: String, trim: true, maxlength: 5000 },
    feedback: { type: String, enum: ['HAPPY', 'NEUTRAL', 'UNHAPPY'] },
    feedbackAt: { type: Date },
  },
  { timestamps: true },
);

leadSchema.index({ status: 1, createdAt: -1 });
leadSchema.index({ conversationId: 1 }, { unique: true });
leadSchema.index({ customerId: 1, updatedAt: -1 });

export type LeadDocument = InferSchemaType<typeof leadSchema>;
export const Lead = model('Lead', leadSchema);
