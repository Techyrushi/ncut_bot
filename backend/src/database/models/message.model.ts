import { model, Schema, type InferSchemaType } from 'mongoose';

const messageSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    whatsappMessageId: { type: String, sparse: true, unique: true },
    direction: { type: String, enum: ['INBOUND', 'OUTBOUND'], required: true },
    messageType: { type: String, enum: ['TEXT', 'IMAGE', 'INTERACTIVE', 'TEMPLATE', 'UNKNOWN'], required: true },
    content: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'],
      default: 'RECEIVED',
      index: true,
    },
    timestamp: { type: Date, required: true, index: true },
    error: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, timestamp: -1 });

export type MessageDocument = InferSchemaType<typeof messageSchema>;
export const Message = model('Message', messageSchema);
