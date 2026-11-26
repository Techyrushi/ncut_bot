import { model, Schema, type InferSchemaType } from 'mongoose';

const pushSubscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    expirationTime: { type: Number },
  },
  { timestamps: true },
);

pushSubscriptionSchema.index({ userId: 1, updatedAt: -1 });

export type PushSubscriptionDocument = InferSchemaType<typeof pushSubscriptionSchema>;
export const PushSubscription = model('PushSubscription', pushSubscriptionSchema);
