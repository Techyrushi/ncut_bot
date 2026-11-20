import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiResponse, PageResult, Product } from '../types/api';
import { useAuth } from '../contexts/AuthContext';
import { ConfirmDialog } from '../components/ConfirmDialog';

const suggestedCategories = [
  'Flap Disc',
  'Velcro Disc',
  'PSA Disc',
  'Velcro & PSA Backup Pads',
  'Fiber Disc',
  'Quick Change Disc',
  'Mop Wheel',
  'Non-Woven Disc',
  'Non-Woven Wheel',
  'Non-Woven Velcro Disc',
  'Hand Pad',
  'Cutting Wheel',
  'DC Wheel (Grinding Wheel)',
  'Emery Roll',
  'Abrasive Belts',
];

type ProductDraft = {
  name: string;
  category: string;
  description: string;
  imageUrl: string;
  whatsappProductRetailerId: string;
  sizes: string;
  grits: string;
  colours: string;
  backing: string;
  specifications: string;
};

type ProductPayload = Omit<Product, '_id' | 'isActive'>;

const emptyDraft: ProductDraft = {
  name: '',
  category: '',
  description: '',
  imageUrl: '',
  whatsappProductRetailerId: '',
  sizes: '',
  grits: '',
  colours: '',
  backing: '',
  specifications: '',
};

async function optimizeProductImage(file: File): Promise<File> {
  if (file.size <= 512 * 1024) return file;

  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare the product image.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) throw new Error('Your browser could not compress the product image.');
    if (blob.size >= file.size) return file;
    const filename = file.name.replace(/\.[^.]+$/, '');
    return new File([blob], `${filename}.jpg`, { type: 'image/jpeg' });
  } finally {
    image.close();
  }
}

export function ProductsPage() {
  const client = useQueryClient();
  const { user } = useAuth();
  const canEdit = user?.role === 'ADMIN';
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [notice, setNotice] = useState('');
  const [productToArchive, setProductToArchive] = useState<Product>();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('all');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState(emptyDraft);
  const [imageFile, setImageFile] = useState<File>();
  const [imagePreview, setImagePreview] = useState('');
  const pageSize = 10;
  const productQueryKey = ['products', search, categoryFilter, statusFilter, page] as const;

  useEffect(() => {
    if (!imagePreview.startsWith('blob:')) return;
    return () => URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);

  const products = useQuery({
    queryKey: productQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(pageSize),
        active: statusFilter === 'all' ? 'all' : String(statusFilter === 'archived'),
      });
      if (search.trim()) params.set('search', search.trim());
      if (categoryFilter) params.set('category', categoryFilter);
      return (await api.get<ApiResponse<PageResult<Product>>>(`/products?${params}`)).data.data;
    },
  });
  const categoryOptions = useQuery({
    queryKey: ['product-categories'],
    queryFn: async () => (await api.get<ApiResponse<string[]>>('/products/categories')).data.data,
  });
  const categories = [...new Set([...suggestedCategories, ...(categoryOptions.data ?? [])])].sort((a, b) =>
    a.localeCompare(b),
  );
  const catalogCategories = categoryOptions.data ?? [];
  const save = useMutation({
    mutationFn: async ({ id, body, file }: { id?: string; body: ProductPayload; file?: File }) => {
      let payload = body;
      if (file) {
        const upload = await api.post<ApiResponse<{ imageUrl: string }>>('/products/image-upload', file, {
          headers: { 'Content-Type': file.type },
        });
        payload = { ...payload, imageUrl: upload.data.data.imageUrl };
      }
      const response = id
        ? await api.put<ApiResponse<Product>>(`/products/${id}`, payload)
        : await api.post<ApiResponse<Product>>('/products', payload);
      return response.data.data;
    },
    onMutate: async ({ id, body, file }) => {
      await client.cancelQueries({ queryKey: ['products'] });
      const previous = client.getQueryData<PageResult<Product>>(productQueryKey);
      const existing = previous?.items.find((product) => product._id === id);
      const optimistic: Product = {
        ...body,
        _id: id ?? `optimistic-${Date.now()}`,
        imageUrl: imagePreview || body.imageUrl || (file ? URL.createObjectURL(file) : ''),
        isActive: existing?.isActive ?? true,
      };
      client.setQueryData<PageResult<Product>>(productQueryKey, (current) => {
        if (!current) return current;
        if (id) {
          const matchesStatus =
            statusFilter === 'all' ||
            (statusFilter === 'active' && optimistic.isActive) ||
            (statusFilter === 'archived' && !optimistic.isActive);
          const matchesFilters =
            (!categoryFilter || body.category === categoryFilter) &&
            matchesStatus &&
            (!search.trim() ||
            `${body.name} ${body.slug} ${body.category} ${body.description} ${body.whatsappProductRetailerId ?? ''}`
                .toLowerCase()
                .includes(search.trim().toLowerCase()));
          const alreadyListed = current.items.some((product) => product._id === id);
          return {
            ...current,
            items: alreadyListed
              ? matchesFilters
                ? current.items.map((product) => (product._id === id ? optimistic : product))
                : current.items.filter((product) => product._id !== id)
              : current.items,
            total: alreadyListed && !matchesFilters ? Math.max(0, current.total - 1) : current.total,
          };
        }
        const matchesFilters =
          page === 1 &&
          (statusFilter === 'all' || statusFilter === 'active') &&
          (!categoryFilter || body.category === categoryFilter) &&
          (!search.trim() ||
            `${body.name} ${body.slug} ${body.category} ${body.description} ${body.whatsappProductRetailerId ?? ''}`
              .toLowerCase()
              .includes(search.trim().toLowerCase()));
        return matchesFilters
          ? { ...current, items: [optimistic, ...current.items].slice(0, pageSize), total: current.total + 1 }
          : current;
      });
      return { previous };
    },
    onSuccess: async (product, variables) => {
      await client.invalidateQueries({ queryKey: ['product-categories'] });
      client.setQueryData<PageResult<Product>>(productQueryKey, (current) => {
        if (!current) return current;
        const index = current.items.findIndex((item) =>
          variables.id ? item._id === variables.id : item._id.startsWith('optimistic-'),
        );
        if (index < 0) return current;
        return {
          ...current,
          items: current.items.map((item, itemIndex) => (itemIndex === index ? product : item)),
        };
      });
      setShowForm(false);
      setEditingId(undefined);
      setDraft(emptyDraft);
      setImageFile(undefined);
      setImagePreview('');
      setNotice(variables.id ? 'Product details updated.' : 'Product added to your catalogue.');
    },
    onError: (error, _variables, context) => {
      if (context?.previous) client.setQueryData(productQueryKey, context.previous);
      setNotice(error instanceof Error ? error.message : 'Unable to save product.');
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['products'] });
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/products/${id}`),
    onSuccess: async () => {
      setProductToArchive(undefined);
      await client.invalidateQueries({ queryKey: ['products'] });
      setNotice('Product archived.');
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!imageFile && !draft.imageUrl) {
      setNotice('Add a product image so WhatsApp can show it to customers.');
      return;
    }

    let specifications: Record<string, unknown>;
    try {
      specifications = parseDetails(draft.specifications);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Check the additional product details.');
      return;
    }

    const body: ProductPayload = {
      name: draft.name.trim(),
      slug: makeSlug(draft.name),
      category: draft.category,
      description: draft.description.trim(),
      imageUrl: draft.imageUrl,
      whatsappProductRetailerId: draft.whatsappProductRetailerId.trim(),
      sizes: splitValues(draft.sizes),
      grits: splitValues(draft.grits),
      colours: splitValues(draft.colours),
      backing: splitValues(draft.backing),
      specifications,
    };
    save.mutate({ id: editingId, body, file: imageFile });
  }

  function edit(product: Product) {
    setEditingId(product._id);
    setDraft({
      name: product.name,
      category: product.category,
      description: product.description,
      imageUrl: product.imageUrl ?? '',
      whatsappProductRetailerId: product.whatsappProductRetailerId ?? '',
      sizes: product.sizes.join(', '),
      grits: product.grits.join(', '),
      colours: product.colours.join(', '),
      backing: product.backing.join(', '),
      specifications: Object.entries(product.specifications ?? {})
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join('\n'),
    });
    setImageFile(undefined);
    setImagePreview(product.imageUrl ?? '');
    setShowForm(true);
  }

  async function chooseImage(file?: File) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setNotice('Choose a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setNotice('Product images must be 5 MB or smaller.');
      return;
    }
    setNotice('');
    try {
      const optimized = await optimizeProductImage(file);
      setImageFile(optimized);
      setImagePreview(URL.createObjectURL(optimized));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to prepare the product image.');
    }
  }

  function startNewProduct() {
    setEditingId(undefined);
    setDraft(emptyDraft);
    setImageFile(undefined);
    setImagePreview('');
    setShowForm((open) => !open);
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CATALOGUE / INVENTORY</div>
          <h1>Products</h1>
          <p>Keep product information accurate for every automated conversation.</p>
        </div>
        {canEdit && (
          <button className="primary-button" onClick={startNewProduct}>
            ＋ Add product
          </button>
        )}
      </div>
      {notice && (
        <div className="alert" role="status">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
      {showForm && (
        <form className="panel product-form" onSubmit={submit}>
          <div className="product-form-heading">
            <div className="product-form-title">
              <span className="product-form-icon">✦</span>
              <div>
                <div className="eyebrow">{editingId ? 'EDIT CATALOGUE ITEM' : 'NEW CATALOGUE ITEM'}</div>
                <h2>{editingId ? 'Update your product' : 'Add a catalogue product'}</h2>
                <p>Share accurate product information with your team and WhatsApp customers.</p>
              </div>
            </div>
            <button type="button" className="secondary-button" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
          <div className="product-form-section">
            <div className="product-section-heading">
              <span>01</span>
              <div>
                <strong>Product overview</strong>
                <small>Name, category, and a customer-friendly description.</small>
              </div>
            </div>
            <div className="form-grid">
              <label>
                <span className="field-label">
                  Product name <span className="required-mark">*</span>
                </span>
                <input
                  required
                  maxLength={160}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="e.g. Premium flap disc"
                />
              </label>
              <label>
                <span className="field-label">
                  Product category <span className="required-mark">*</span>
                </span>
                <CategoryCombobox
                  categories={categories}
                  value={draft.category}
                  onChange={(category) => setDraft({ ...draft, category })}
                  required
                />
              </label>
              <label className="wide">
                <span className="field-label">
                  Product description <span className="required-mark">*</span>
                </span>
                <textarea
                  required
                  maxLength={5000}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="Describe the product, its use, and what makes it suitable."
                />
                <span className="field-hint">{draft.description.length}/5000 characters</span>
              </label>
            </div>
          </div>
          <div className="product-form-section">
            <div className="product-section-heading">
              <span>02</span>
              <div>
                <strong>Specifications</strong>
                <small>Only add verified sizes and technical details.</small>
              </div>
            </div>
            <div className="form-grid product-spec-grid">
              <label>
                Sizes
                <input
                  placeholder={'e.g. 4", 5", 7"'}
                  value={draft.sizes}
                  onChange={(event) => setDraft({ ...draft, sizes: event.target.value })}
                />
              </label>
              <label>
                Grits
                <input
                  placeholder="Comma-separated values"
                  value={draft.grits}
                  onChange={(event) => setDraft({ ...draft, grits: event.target.value })}
                />
              </label>
              <label>
                Colours
                <input
                  placeholder="Comma-separated values"
                  value={draft.colours}
                  onChange={(event) => setDraft({ ...draft, colours: event.target.value })}
                />
              </label>
              <label>
                Backing
                <input
                  placeholder="e.g. paper, film, metal"
                  value={draft.backing}
                  onChange={(event) => setDraft({ ...draft, backing: event.target.value })}
                />
              </label>
              <label className="wide">
                Additional product details
                <textarea
                  value={draft.specifications}
                  onChange={(event) => setDraft({ ...draft, specifications: event.target.value })}
                  placeholder={'One detail per line, for example:\nThickness: 13 mm\nHardness: U0, U1, U3'}
                />
              </label>
            </div>
          </div>
          <div className="product-form-section">
            <div className="product-section-heading">
              <span>03</span>
              <div>
                <strong>Product image</strong>
                <small>Choose the image customers will see in WhatsApp.</small>
              </div>
            </div>
            <div className="product-image-row">
              <label className="product-image-drop">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  required={!draft.imageUrl && !imageFile}
                  onChange={(event) => chooseImage(event.target.files?.[0])}
                />
                <span className="upload-icon">↑</span>
                <strong>{imageFile?.name ?? (imagePreview ? 'Choose a different image' : 'Choose an image from your device')}</strong>
                <small>JPEG, PNG, or WebP · up to 5 MB</small>
              </label>
              {imagePreview ? (
                <div className="product-preview-card">
                  <img className="product-image-preview" src={imagePreview} alt="Product preview" />
                  <span>WhatsApp preview</span>
                </div>
              ) : (
                <div className="product-preview-placeholder">
                  <span>▧</span>
                  <small>Your product image preview</small>
                </div>
              )}
            </div>
          </div>
          <div className="product-form-section">
            <div className="product-section-heading">
              <span>04</span>
              <div>
                <strong>Meta WhatsApp catalog mapping</strong>
                <small>Connect this product to its item in Meta Commerce Manager.</small>
              </div>
            </div>
            <div className="form-grid">
              <label>
                Meta catalog retailer ID
                <input
                  maxLength={100}
                  value={draft.whatsappProductRetailerId}
                  onChange={(event) => setDraft({ ...draft, whatsappProductRetailerId: event.target.value })}
                  placeholder="Exact retailer_id / SKU from Meta"
                />
                <span className="field-hint">
                  Must exactly match this item’s retailer_id in the WhatsApp catalog.
                </span>
              </label>
            </div>
          </div>
          <div className="product-form-footer">
            <p className="muted small">These verified details and image will be shared with WhatsApp customers.</p>
            <button className="primary-button" disabled={save.isPending}>
              {save.isPending ? 'Saving product…' : editingId ? 'Save changes' : 'Save product'} <span>→</span>
            </button>
          </div>
        </form>
      )}
      <div className="panel table-panel">
        <div className="panel-heading product-table-heading">
          <div>
            <div className="eyebrow">PRODUCT LIBRARY</div>
            <h2>{products.data?.total ?? 0} catalogue items</h2>
          </div>
          <div className="table-result-count">
            Showing {products.data?.items.length ?? 0} of {products.data?.total ?? 0}
          </div>
        </div>
        <div className="table-toolbar">
          <label className="table-search">
            <span aria-hidden="true">⌕</span>
            <input
              placeholder="Search products..."
              aria-label="Search products"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="filter-control">
            <span>Category</span>
            <select
              aria-label="Filter products by category"
              value={categoryFilter}
              onChange={(event) => {
                setCategoryFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All products</option>
              {catalogCategories.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </label>
          <label className="filter-control">
            <span>Status</span>
            <select
              aria-label="Filter products by status"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as typeof statusFilter);
                setPage(1);
              }}
            >
              <option value="all">All products</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          {(search || categoryFilter || statusFilter !== 'all') && (
            <button
              type="button"
              className="table-reset-button"
              onClick={() => {
                setSearch('');
                setCategoryFilter('');
                setStatusFilter('all');
                setPage(1);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {products.isError && (
          <div className="alert error">
            {products.error instanceof Error ? products.error.message : 'Unable to load products.'}
          </div>
        )}
        {products.isLoading && <div className="table-loading">Loading products…</div>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>PRODUCT</th>
                <th>CATEGORY</th>
                <th>META RETAILER ID</th>
                <th>DESCRIPTION</th>
                <th>STATUS</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(products.data?.items ?? []).map((product) => (
                <tr key={product._id}>
                  <td>
                    <div className="product-cell">
                      {product.imageUrl ? (
                        <img src={product.imageUrl} alt="" />
                      ) : (
                        <div className="product-placeholder">◈</div>
                      )}
                      <div>
                        <strong>{product.name}</strong>
                        <span>/{product.slug}</span>
                      </div>
                    </div>
                  </td>
                  <td>{product.category}</td>
                  <td>{product.whatsappProductRetailerId || <span className="muted">Not mapped</span>}</td>
                  <td className="description-cell">{product.description}</td>
                  <td>
                    <span className={`status-chip ${product.isActive ? 'on' : 'off'}`}>
                      {product.isActive ? 'ACTIVE' : 'ARCHIVED'}
                    </span>
                  </td>
                  <td>
                    {canEdit && (
                      <div className="product-action-group">
                        <button
                          type="button"
                          className="product-action-button edit"
                          title={`Edit ${product.name}`}
                          onClick={() => edit(product)}
                        >
                          Edit
                        </button>
                        {product.isActive && (
                          <button
                            type="button"
                            className="product-action-button archive"
                            title={`Archive ${product.name}; it will no longer appear in WhatsApp product selection`}
                            onClick={() => {
                              remove.reset();
                              setProductToArchive(product);
                            }}
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {products.data?.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-row">
                    No products match these filters. Try changing your search or filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="table-pagination">
          <span>
            {products.data?.total
              ? `Page ${page} of ${Math.max(1, Math.ceil(products.data.total / pageSize))}`
              : 'No results'}
          </span>
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={page === 1 || products.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!products.data || page * pageSize >= products.data.total || products.isFetching}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </div>
        </div>
        {productToArchive && (
          <ConfirmDialog
            title="Archive this product?"
            message={`${productToArchive.name} will be hidden from the active catalogue and WhatsApp product selection. Existing lead history will remain.`}
            confirmLabel="Archive product"
            pendingLabel="Archiving…"
            isPending={remove.isPending}
            error={remove.error instanceof Error ? remove.error.message : undefined}
            onCancel={() => setProductToArchive(undefined)}
            onConfirm={() => remove.mutate(productToArchive._id)}
          />
        )}
      </div>
    </div>
  );
}

function splitValues(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function makeSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseDetails(value: string): Record<string, string> {
  const details: Record<string, string> = {};
  for (const line of value.split('\n').map((item) => item.trim()).filter(Boolean)) {
    const separator = line.indexOf(':');
    if (separator <= 0 || !line.slice(separator + 1).trim()) {
      throw new Error('Write additional details as “Name: value”, one detail per line.');
    }
    const key = line.slice(0, separator).trim();
    if (key in details) throw new Error(`The additional detail “${key}” appears more than once.`);
    details[key] = line.slice(separator + 1).trim();
  }
  return details;
}

function CategoryCombobox({
  categories,
  value,
  onChange,
  required = false,
}: {
  categories: string[];
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const normalizedValue = value.trim().toLocaleLowerCase();
  const matches = categories.filter((category) => category.toLocaleLowerCase().includes(normalizedValue)).slice(0, 8);
  const canCreate =
    Boolean(value.trim()) &&
    value.trim().length <= 32 &&
    !categories.some((category) => category.toLocaleLowerCase() === normalizedValue);
  const listId = 'product-category-options';

  function choose(category: string) {
    onChange(category);
    setIsOpen(false);
  }

  return (
    <div
      className="category-combobox"
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setIsOpen(false);
        }
      }}
    >
      <div className="category-combobox-control">
        <input
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-label="Search or add a product category"
          autoComplete="off"
          maxLength={32}
          required={required}
          value={value}
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setIsOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setIsOpen(false);
            if (event.key === 'ArrowDown' && isOpen) {
              event.preventDefault();
              event.currentTarget.parentElement?.parentElement
                ?.querySelector<HTMLButtonElement>('[role="option"]')
                ?.focus();
            }
            if (event.key === 'Enter' && isOpen) {
              event.preventDefault();
              if (matches.length) choose(matches[0]!);
              else if (canCreate) choose(value.trim());
            }
          }}
          placeholder="Search or type a new category"
        />
        <span aria-hidden="true">⌄</span>
      </div>
      {isOpen && (
        <div className="category-combobox-options" id={listId} role="listbox" aria-label="Product categories">
          {matches.map((category) => (
            <button
              type="button"
              role="option"
              aria-selected={value === category}
              key={category}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(category)}
            >
              {category}
            </button>
          ))}
          {canCreate && (
            <button
              type="button"
              role="option"
              className="create-category-option"
              aria-selected="false"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(value.trim())}
            >
              <span aria-hidden="true">＋</span> Add “{value.trim()}”
            </button>
          )}
          {!matches.length && !canCreate && <span className="category-empty-option">Type a category to add it.</span>}
        </div>
      )}
    </div>
  );
}
