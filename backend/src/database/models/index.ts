import { ActivityLog } from './activity-log.model';
import { BulkCampaign, BulkCampaignRecipient } from './bulk-campaign.model';
import { Conversation } from './conversation.model';
import { Customer } from './customer.model';
import { Lead } from './lead.model';
import { Message } from './message.model';
import { MessageTemplate } from './message-template.model';
import { Product } from './product.model';
import { RevokedToken } from './revoked-token.model';
import { User } from './user.model';
import { WebhookEvent } from './webhook-event.model';
import { WorkspaceSettings } from './workspace-settings.model';

const models = [
  ActivityLog,
  BulkCampaign,
  BulkCampaignRecipient,
  Conversation,
  Customer,
  Lead,
  Message,
  MessageTemplate,
  Product,
  RevokedToken,
  User,
  WebhookEvent,
  WorkspaceSettings,
];

export async function createModelIndexes(): Promise<void> {
  await Promise.all(models.map((model) => model.createIndexes()));
}
