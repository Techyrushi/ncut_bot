import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiResponse, PageResult, Product } from '../types/api';
import { useAuth } from '../contexts/AuthContext';

export function ProductsPage() {
  const client = useQueryClient();
  const { user } = useAuth();
  const canEdit = user?.role === 'ADMIN';
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [notice, setNotice] = useState('');
  const emptyDraft = {
    name: '',
    slug: '',
    category: '',
    description: '',
    imageUrl: '',
    sizes: '',
    grits: '',
    colours: '',
    backing: '',
    specifications: '{}',
  };
  const [draft, setDraft] = useState(emptyDraft);
  const products = useQuery({
    queryKey: ['products'],
    queryFn: async () => (await api.get<ApiResponse<PageResult<Product>>>('/products?active=all')).data.data.items,
  });
  const save = useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: typeof draft }) => {
      const { sizes, grits, colours, backing, specifications, ...fields } = body;
      const payload = {
        ...fields,
        sizes: splitValues(sizes),
        grits: splitValues(grits),
        colours: splitValues(colours),
        backing: splitValues(backing),
        specifications: JSON.parse(specifications) as Record<string, unknown>,
      };
      return id ? api.put(`/products/${id}`, payload) : api.post('/products', payload);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['products'] });
      setShowForm(false);
      setEditingId(undefined);
      setDraft(emptyDraft);
      setNotice(editingId ? 'Product details updated.' : 'Product added to your catalogue.');
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Unable to save product.'),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/products/${id}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['products'] });
      setNotice('Product archived.');
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate({ id: editingId, body: draft });
  }
  function edit(product: Product) {
    setEditingId(product._id);
    setDraft({
      name: product.name,
      slug: product.slug,
      category: product.category,
      description: product.description,
      imageUrl: product.imageUrl ?? '',
      sizes: product.sizes.join(', '),
      grits: product.grits.join(', '),
      colours: product.colours.join(', '),
      backing: product.backing.join(', '),
      specifications: JSON.stringify(
        (product as Product & { specifications?: Record<string, unknown> }).specifications ?? {},
        null,
        2,
      ),
    });
    setShowForm(true);
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
          <button
            className="primary-button"
            onClick={() => {
              setEditingId(undefined);
              setDraft(emptyDraft);
              setShowForm(!showForm);
            }}
          >
            ＋ Add product
          </button>
        )}
      </div>
      {notice && (
        <div className="alert">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
      {showForm && (
        <form className="panel product-form" onSubmit={submit}>
          <div className="panel-heading">
            <div>
              <div className="eyebrow">{editingId ? 'EDIT CATALOGUE ITEM' : 'NEW CATALOGUE ITEM'}</div>
              <h2>Product details</h2>
            </div>
            <button type="button" className="text-button" onClick={() => setShowForm(false)}>
              Close
            </button>
          </div>
          <div className="form-grid">
            {(
              [
                'name',
                'slug',
                'category',
                'imageUrl',
                'description',
                'sizes',
                'grits',
                'colours',
                'backing',
                'specifications',
              ] as const
            ).map((field) => (
              <label key={field} className={['description', 'specifications'].includes(field) ? 'wide' : ''}>
                {field === 'imageUrl' ? 'Image URL (optional)' : field[0].toUpperCase() + field.slice(1)}
                {['description', 'specifications'].includes(field) ? (
                  <textarea
                    required={field === 'description'}
                    value={draft[field]}
                    onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                  />
                ) : (
                  <input
                    required={['name', 'slug', 'category'].includes(field)}
                    placeholder={
                      ['sizes', 'grits', 'colours', 'backing'].includes(field) ? 'Comma-separated values' : ''
                    }
                    value={draft[field]}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [field]:
                          field === 'name' && !draft.slug
                            ? e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
                            : e.target.value,
                      })
                    }
                  />
                )}
              </label>
            ))}
          </div>
          <p className="muted small">
            Only enter verified product descriptions and specifications. Specifications must be a JSON object.
          </p>
          <button className="primary-button" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editingId ? 'Save changes' : 'Save product'} <span>→</span>
          </button>
        </form>
      )}
      <div className="panel table-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">PRODUCT LIBRARY</div>
            <h2>{products.data?.length ?? 0} catalogue items</h2>
          </div>
          <div className="search-wrap">
            <span>⌕</span>
            <input
              placeholder="Search catalogue"
              onChange={(e) => {
                /* Search is supported by the API query contract. */ void e.target.value;
              }}
            />
          </div>
        </div>
        {products.isError && (
          <div className="alert error">
            {products.error instanceof Error ? products.error.message : 'Unable to load products.'}
          </div>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>PRODUCT</th>
                <th>CATEGORY</th>
                <th>DESCRIPTION</th>
                <th>STATUS</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(products.data ?? []).map((product) => (
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
                  <td className="description-cell">{product.description}</td>
                  <td>
                    <span className={`status-chip ${product.isActive ? 'on' : 'off'}`}>
                      {product.isActive ? 'ACTIVE' : 'ARCHIVED'}
                    </span>
                  </td>
                  <td>
                    {canEdit && (
                      <>
                        <button className="text-button" onClick={() => edit(product)}>
                          Edit
                        </button>
                        {product.isActive && (
                          <button className="text-button danger-text" onClick={() => remove.mutate(product._id)}>
                            Archive
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {products.data?.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-row">
                    No products yet. Add verified catalogue details to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
