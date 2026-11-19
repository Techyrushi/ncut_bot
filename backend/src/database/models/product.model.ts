import { model, Schema, type InferSchemaType } from 'mongoose';

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    category: { type: String, required: true, trim: true, maxlength: 32 },
    sizes: { type: [String], default: [] },
    grits: { type: [String], default: [] },
    colours: { type: [String], default: [] },
    backing: { type: [String], default: [] },
    specifications: { type: Schema.Types.Mixed, default: {} },
    imageUrl: { type: String, trim: true, maxlength: 2048 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ name: 'text', description: 'text', category: 'text' });

export type ProductDocument = InferSchemaType<typeof productSchema>;
export const Product = model('Product', productSchema);
