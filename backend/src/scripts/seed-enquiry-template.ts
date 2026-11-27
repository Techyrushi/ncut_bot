import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { MessageTemplate } from '../database/models/message-template.model';

async function seedEnquiryTemplate(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const imageUrl = new URL('/PUNE TEMPLATE.png', env.FRONTEND_URL).toString();
  const result = await MessageTemplate.updateOne(
    { name: 'ncut_product_enquiry_thank_you', languageCode: 'en' },
    {
      $setOnInsert: {
        name: 'ncut_product_enquiry_thank_you',
        languageCode: 'en',
        metaStatus: 'PENDING',
      },
      $set: {
        category: 'UTILITY',
        directSend: true,
        components: [
          { type: 'HEADER', format: 'IMAGE' },
          {
            type: 'BODY',
            text: 'Thank you for your interest in N-CUT Abrasives! Please contact our team for pricing or product enquiries.',
          },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'QUICK_REPLY', id: 'connect_sales', text: 'Contact Sales' }],
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

  logger.info(
    { inserted: result.upsertedCount, name: 'ncut_product_enquiry_thank_you', directSend: true },
    'N-CUT product enquiry Direct Send entry prepared',
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
