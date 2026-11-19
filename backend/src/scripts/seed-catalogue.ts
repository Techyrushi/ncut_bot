import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { Product } from '../database/models/product.model';
import { initialCatalogueProducts } from '../modules/products/catalogue-seed';

async function seedCatalogue(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const imageBaseUrl = new URL('/products/', env.FRONTEND_URL);
  let inserted = 0;
  for (const product of initialCatalogueProducts) {
    const { imageFile, ...fields } = product;
    const result = await Product.updateOne(
      { slug: fields.slug },
      {
        $setOnInsert: {
          ...fields,
          imageUrl: new URL(imageFile, imageBaseUrl).toString(),
        },
      },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    inserted += result.upsertedCount;
  }
  logger.info({ inserted, total: initialCatalogueProducts.length }, 'Initial N-CUT catalogue seed completed');
}

seedCatalogue()
  .catch((error: unknown) => {
    logger.error({ err: error }, 'Initial N-CUT catalogue seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
