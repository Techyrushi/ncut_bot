import { model, Schema, type InferSchemaType } from 'mongoose';

const webhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    eventType: { type: String, required: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    processingStatus: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'],
      default: 'PENDING',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    availableAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date },
    receivedAt: { type: Date, default: Date.now, index: true },
    processedAt: { type: Date },
  },
  { timestamps: true },
);

webhookEventSchema.index({ processingStatus: 1, receivedAt: 1 });
webhookEventSchema.index({ processingStatus: 1, lockedAt: 1 });

export type WebhookEventDocument = InferSchemaType<typeof webhookEventSchema>;
export const WebhookEvent = model('WebhookEvent', webhookEventSchema);
