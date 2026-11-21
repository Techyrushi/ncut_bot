import { model, Schema, type InferSchemaType } from 'mongoose';

export const conversationStates = [
  'NEW',
  'WELCOME_SENT',
  'PRODUCT_MENU',
  'PRODUCT_DETAILS',
  'INTEREST_TRIGGERED',
  'HUMAN_HANDOVER',
  'FEEDBACK',
  'CLOSED',
] as const;

const conversationSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    status: { type: String, enum: ['OPEN', 'HUMAN_HANDOVER', 'CLOSED'], default: 'OPEN', index: true },
    currentStep: { type: String, enum: conversationStates, default: 'NEW', index: true },
    selectedProductIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Product' }], default: [] },
    uniqueProductCount: { type: Number, min: 0, default: 0 },
    interestTriggeredAt: { type: Date },
    interestPromptStatus: { type: String, enum: ['PENDING', 'SENDING', 'SENT'] },
    interestPromptLockedAt: { type: Date },
    currentCategory: { type: String },
    lastMessageAt: { type: Date, index: true },
    handoverAt: { type: Date },
    lastInteractionAt: { type: Date, index: true },
  },
  { timestamps: true },
);

conversationSchema.index({ customerId: 1, status: 1, updatedAt: -1 });
conversationSchema.index(
  { customerId: 1 },
  { name: 'customer_open_unique', unique: true, partialFilterExpression: { status: 'OPEN' } },
);

export type ConversationDocument = InferSchemaType<typeof conversationSchema>;
export const Conversation = model('Conversation', conversationSchema);
