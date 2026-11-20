import { model, Schema } from 'mongoose';

export const DEFAULT_WELCOME_MESSAGE =
  '👋 Thank you for connecting with us!\n\nExplore our range of abrasive and finishing products.';

const workspaceSettingsSchema = new Schema(
  {
    key: { type: String, enum: ['workspace'], default: 'workspace', unique: true },
    businessPhoneNumber: { type: String, trim: true, maxlength: 30, default: '' },
    welcomeMessage: { type: String, trim: true, maxlength: 1024, default: DEFAULT_WELCOME_MESSAGE },
    leadNotificationSetupAt: { type: Date },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const WorkspaceSettings = model('WorkspaceSettings', workspaceSettingsSchema);
