import { model, Schema, type InferSchemaType } from 'mongoose';

const messageTemplateSchema = new Schema(
  {
    name: { type: String, required: true, lowercase: true, trim: true },
    metaTemplateId: { type: String, trim: true },
    languageCode: { type: String, required: true, trim: true },
    category: { type: String, enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'], required: true },
    metaStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED'], default: 'PENDING', index: true },
    components: { type: [Schema.Types.Mixed], default: [] },
    defaultSendComponents: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

messageTemplateSchema.index({ name: 1, languageCode: 1 }, { unique: true });

export type MessageTemplateDocument = InferSchemaType<typeof messageTemplateSchema>;
export const MessageTemplate = model('MessageTemplate', messageTemplateSchema);
