import { model, Schema, type InferSchemaType } from 'mongoose';

const activityLogSchema = new Schema(
  {
    source: { type: String, enum: ['USER', 'SYSTEM'], required: true },
    action: { type: String, required: true, trim: true, maxlength: 180 },
    summary: { type: String, trim: true, maxlength: 240 },
    resourceType: { type: String, trim: true, maxlength: 64 },
    resourceId: { type: String, trim: true, maxlength: 64 },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String, enum: ['ADMIN', 'SALES'] },
    statusCode: { type: Number, min: 100, max: 599 },
    occurredAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { versionKey: false },
);

activityLogSchema.index({ source: 1, occurredAt: -1 });

export type ActivityLogDocument = InferSchemaType<typeof activityLogSchema>;
export const ActivityLog = model('ActivityLog', activityLogSchema);
