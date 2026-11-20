import { model, Schema, type InferSchemaType } from 'mongoose';

export function normalizePhoneIdentity(phone: string | undefined | null): string | undefined {
  const digits = phone?.replace(/[^0-9]/g, '');
  return digits || undefined;
}

const customerSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 120 },
    phoneNumber: { type: String, trim: true, index: true },
    whatsappId: { type: String, required: true, trim: true, unique: true },
    phoneIdentity: { type: String, trim: true, index: true, select: false },
    profileName: { type: String, trim: true, maxlength: 120 },
    optInStatus: { type: String, enum: ['UNKNOWN', 'OPTED_IN', 'OPTED_OUT'], default: 'UNKNOWN' },
    optInAt: { type: Date },
    optInSource: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

customerSchema.pre('validate', function setPhoneIdentity() {
  this.phoneIdentity = normalizePhoneIdentity(this.phoneNumber || this.whatsappId);
});
customerSchema.index({ name: 'text', profileName: 'text' });

export type CustomerDocument = InferSchemaType<typeof customerSchema>;
export const Customer = model('Customer', customerSchema);
