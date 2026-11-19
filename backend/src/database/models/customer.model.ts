import { model, Schema, type InferSchemaType } from 'mongoose';

const customerSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 120 },
    phoneNumber: { type: String, trim: true, index: true },
    whatsappId: { type: String, required: true, trim: true, unique: true },
    profileName: { type: String, trim: true, maxlength: 120 },
    optInStatus: { type: String, enum: ['UNKNOWN', 'OPTED_IN', 'OPTED_OUT'], default: 'UNKNOWN' },
    optInAt: { type: Date },
    optInSource: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

customerSchema.index({ name: 'text', profileName: 'text' });

export type CustomerDocument = InferSchemaType<typeof customerSchema>;
export const Customer = model('Customer', customerSchema);
