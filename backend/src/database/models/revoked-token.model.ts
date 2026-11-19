import { model, Schema } from 'mongoose';

const revokedTokenSchema = new Schema(
  {
    tokenId: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

revokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RevokedToken = model('RevokedToken', revokedTokenSchema);
