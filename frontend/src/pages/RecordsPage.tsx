import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiResponse, PageResult } from '../types/api';
import { useAuth } from '../contexts/AuthContext';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface RecordPageProps {
  kind: 'customers' | 'conversations' | 'leads';
  title: string;
  eyebrow: string;
}

type ConsentFilter = 'ALL' | 'UNKNOWN' | 'OPTED_IN' | 'OPTED_OUT';

export function RecordsPage({ kind, title, eyebrow }: RecordPageProps) {
  const [search, setSearch] = useState('');
  const [consentFilter, setConsentFilter] = useState<ConsentFilter>('ALL');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const [customerToDelete, setCustomerToDelete] = useState<{ id: string; name: string; phone: string }>();
  const { user } = useAuth();
  const client = useQueryClient();
  const pageSize = 10;
  const query = useQuery({
    queryKey: [kind, search, consentFilter, page],
    queryFn: async () => {
      const params: Record<string, string | number> = { page, limit: pageSize };
      if (search.trim()) params.search = search.trim();
      if (kind === 'customers' && consentFilter !== 'ALL') params.optInStatus = consentFilter;
      return (
        await api.get<ApiResponse<PageResult<Record<string, unknown>>>>(`/${kind}`, { params })
      ).data.data;
    },
  });
  const updateOptIn = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'OPTED_IN' | 'OPTED_OUT' }) =>
      api.patch(`/customers/${id}/opt-in`, {
        status,
        source: `Recorded by ${user?.email ?? 'workspace representative'} in the admin dashboard after consent verification`,
      }),
    onSuccess: async (_response, { status }) => {
      setNotice(status === 'OPTED_IN' ? 'Customer consent recorded.' : 'Customer opt-out recorded.');
      await client.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Unable to update customer consent.'),
  });
  const deleteCustomer = useMutation({
    mutationFn: async ({ id }: { id: string; name: string }) => api.delete(`/customers/${id}`),
    onSuccess: async (_response, { name }) => {
      setCustomerToDelete(undefined);
      setNotice(`${name} and associated history were deleted.`);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['customers'] }),
        client.invalidateQueries({ queryKey: ['conversations'] }),
        client.invalidateQueries({ queryKey: ['leads'] }),
        client.invalidateQueries({ queryKey: ['dashboard-stats'] }),
        client.invalidateQueries({ queryKey: ['unread-leads-count'] }),
      ]);
    },
    onError: () => setNotice('Unable to delete this customer and its associated history.'),
  });
  const columns =
    kind === 'customers'
      ? ['profileName', 'phoneNumber', 'optInStatus', 'updatedAt']
      : kind === 'leads'
        ? ['customerId', 'status', 'assignedSalesPerson', 'createdAt']
        : ['customerId', 'status', 'currentStep', 'lastMessageAt'];
  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          <p>Find customer records, check WhatsApp consent, and keep your audience up to date.</p>
        </div>
      </div>
      {notice && (
        <div className={`alert ${updateOptIn.isError || deleteCustomer.isError ? 'error' : ''}`} role="status">
          {notice}
          <button type="button" onClick={() => setNotice('')} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      )}
      <section className="panel table-panel customer-table-panel">
        <div className="panel-heading customer-table-heading">
          <div>
            <div className="eyebrow">CUSTOMER DIRECTORY</div>
            <h2>{total} customers</h2>
            <p>Search by name or WhatsApp number; filter by consent status.</p>
          </div>
          <span className="customer-total-pill">{total} total</span>
        </div>
        <div className="table-toolbar customer-toolbar">
          <label className="table-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search name or WhatsApp number..."
              aria-label="Search customers"
            />
          </label>
          {kind === 'customers' && (
            <label className="filter-control">
              <span>Consent</span>
              <select
                aria-label="Filter customers by consent"
                value={consentFilter}
                onChange={(event) => {
                  setConsentFilter(event.target.value as ConsentFilter);
                  setPage(1);
                }}
              >
                <option value="ALL">All consent statuses</option>
                <option value="UNKNOWN">Not recorded</option>
                <option value="OPTED_IN">Opted in</option>
                <option value="OPTED_OUT">Opted out</option>
              </select>
            </label>
          )}
          {(search || consentFilter !== 'ALL') && (
            <button
              type="button"
              className="table-reset-button"
              onClick={() => {
                setSearch('');
                setConsentFilter('ALL');
                setPage(1);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {query.isError && (
          <div className="alert error">
            {query.error instanceof Error ? query.error.message : 'Unable to load records.'}
          </div>
        )}
        {query.isLoading && <div className="table-loading">Loading customers…</div>}
        <div className="table-scroll">
          <table className="admin-data-table customers-table">
            <thead>
              <tr>
                <th>CUSTOMER</th>
                <th>WHATSAPP NUMBER</th>
                <th>CONSENT STATUS</th>
                <th>LAST UPDATED</th>
                {kind === 'customers' && <th className="table-actions-heading">ACTIONS</th>}
              </tr>
            </thead>
            <tbody>
              {(query.data?.items ?? []).map((record, row) => {
                const id = String(record._id ?? row);
                const displayName = String(record.profileName ?? record.name ?? record.phoneNumber ?? 'Customer');
                const consent = String(record.optInStatus ?? 'UNKNOWN');
                const targetStatus = consent === 'OPTED_IN' ? 'OPTED_OUT' : 'OPTED_IN';
                return (
                  <tr key={id}>
                    <td>
                      <div className="customer-name-cell">
                        <span className="customer-initial">{displayName.slice(0, 1).toUpperCase()}</span>
                        <span>
                          <strong>{displayName}</strong>
                          <small>Customer</small>
                        </span>
                      </div>
                    </td>
                    <td className="customer-phone">{formatValue(record.phoneNumber ?? record.whatsappId)}</td>
                    <td>
                      <span className={`status-chip consent-${consent.toLowerCase()}`}>
                        <i />
                        {consent.replace('_', ' ')}
                      </span>
                    </td>
                    <td>{formatDate(record.updatedAt)}</td>
                    {kind === 'customers' && (
                      <td className="table-actions">
                        <div className="customer-actions">
                          <button
                            type="button"
                            className={`table-action-button ${targetStatus === 'OPTED_OUT' ? 'subtle-danger' : ''}`}
                            title={targetStatus === 'OPTED_OUT' ? 'Record that this customer opted out' : 'Record verified customer opt-in'}
                            disabled={updateOptIn.isPending}
                            onClick={() => {
                              const consentText =
                                targetStatus === 'OPTED_IN'
                                  ? 'Only continue if this customer explicitly opted in and you have verified the source. Record opt-in?'
                                  : 'Record this customer as opted out?';
                              if (window.confirm(consentText)) {
                                updateOptIn.mutate({ id, status: targetStatus });
                              }
                            }}
                          >
                            {targetStatus === 'OPTED_OUT' ? 'Opt out' : 'Record opt-in'}
                          </button>
                          {user?.role === 'ADMIN' && (
                            <button
                              type="button"
                              className="table-action-button delete-action-button"
                              title="Permanently delete this customer and all linked history"
                              aria-label={`Delete ${displayName} and associated history`}
                              disabled={deleteCustomer.isPending}
                              onClick={() => {
                                deleteCustomer.reset();
                                setCustomerToDelete({
                                  id,
                                  name: displayName,
                                  phone: String(record.phoneNumber ?? record.whatsappId ?? ''),
                                });
                              }}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              {query.data?.items.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="empty-row">
                    No customers match these filters. Try another name, number, or consent status.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="table-pagination">
          <span>
            {total ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}` : 'No results'}
          </span>
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={page === 1 || query.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={page >= pageCount || query.isFetching}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>
      {customerToDelete && (
        <ConfirmDialog
          title="Delete customer and history?"
          message={`This permanently deletes ${customerToDelete.name}${customerToDelete.phone ? ` (${customerToDelete.phone})` : ''}, along with their conversations, messages, leads, and campaign recipient history. This cannot be undone.`}
          confirmLabel="Delete customer"
          pendingLabel="Deleting…"
          isPending={deleteCustomer.isPending}
          error={deleteCustomer.error instanceof Error ? deleteCustomer.error.message : undefined}
          onCancel={() => setCustomerToDelete(undefined)}
          onConfirm={() => deleteCustomer.mutate({ id: customerToDelete.id, name: customerToDelete.name })}
        />
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return value.length > 30 ? `${value.slice(0, 27)}…` : value;
  if (typeof value === 'object') {
    const item = value as { profileName?: string; name?: string; phoneNumber?: string; email?: string };
    return item.profileName ?? item.name ?? item.phoneNumber ?? item.email ?? '—';
  }
  return String(value);
}

function formatDate(value: unknown): string {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
