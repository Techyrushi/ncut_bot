import { model, Schema, type InferSchemaType } from 'mongoose';

const messageSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    whatsappMessageId: { type: String, sparse: true, unique: true },
    bulkCampaignId: { type: Schema.Types.ObjectId, ref: 'BulkCampaign', index: true },
    bulkRecipientId: { type: Schema.Types.ObjectId, ref: 'BulkCampaignRecipient', index: true },
    direction: { type: String, enum: ['INBOUND', 'OUTBOUND'], required: true },
    messageType: {
      type: String,
      enum: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'INTERACTIVE', 'TEMPLATE', 'UNKNOWN'],
      required: true,
    },
    content: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'],
      default: 'RECEIVED',
      index: true,
    },
    deliveryAction: { type: Schema.Types.Mixed },
    deliveryActionStatus: { type: String, enum: ['PENDING', 'SENDING', 'SENT', 'FAILED'] },
    deliveryActionLockedAt: { type: Date },
    adminNotificationStatus: { type: String, enum: ['SENDING', 'ACCEPTED', 'FAILED'] },
    adminNotificationMessageId: { type: String, sparse: true, index: true },
    adminNotificationDeliveryStatus: { type: String, enum: ['SENT', 'DELIVERED', 'READ', 'FAILED'] },
    webPushStatus: { type: String, enum: ['SENDING', 'ACCEPTED', 'FAILED', 'NO_SUBSCRIPTIONS'] },
    timestamp: { type: Date, required: true, index: true },
    error: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, timestamp: -1 });

export type MessageDocument = InferSchemaType<typeof messageSchema>;
export const Message = model('Message', messageSchema);
