import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { MessageTemplate } from '../database/models/message-template.model';

async function seedEnquiryTemplate(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const imageUrl = new URL('/PUNE TEMPLATE.png', env.FRONTEND_URL).toString();
  const result = await MessageTemplate.updateOne(
    { name: 'enquiry_thank_you_template', languageCode: 'en' },
    {
      $setOnInsert: {
        name: 'enquiry_thank_you_template',
        languageCode: 'en',
        metaStatus: 'PENDING',
      },
      $set: {
        metaTemplateId: '1718800239602030',
        category: 'MARKETING',
        directSend: false,
        components: [
          { type: 'HEADER', format: 'IMAGE' },
          {
            type: 'BODY',
            text: 'Thank you for your interest in N-CUT Abrasives! Please contact our team for pricing or product inquiries.',
          },
          { type: 'FOOTER', text: 'N CUT Abrasives LLP' },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'PHONE_NUMBER', text: 'Call phone number', phone_number: '+919890180821' }],
          },
        ],
        defaultSendComponents: [
          {
            type: 'header',
            parameters: [{ type: 'image', image: { link: imageUrl } }],
          },
        ],
      },
    },
    { upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  const removedOld = await MessageTemplate.deleteOne({
    name: 'ncut_product_enquiry_thank_you',
    languageCode: 'en',
    directSend: true,
  });
  const template = await MessageTemplate.findOne({
    name: 'enquiry_thank_you_template',
    languageCode: 'en',
  })
    .select('metaStatus')
    .lean();
  if (!template) {
    throw new Error('The enquiry_thank_you_template record was not found after syncing.');
  }

  logger.info(
    {
      inserted: result.upsertedCount,
      removedOld: removedOld.deletedCount,
      name: 'enquiry_thank_you_template',
      metaTemplateId: '1718800239602030',
      metaStatus: template.metaStatus,
    },
    'N-CUT enquiry template registry updated',
  );
}

seedEnquiryTemplate()
  .catch((error: unknown) => {
    logger.error({ err: error }, 'N-CUT product enquiry template seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
