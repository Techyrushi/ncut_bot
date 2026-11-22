import { useState, type FormEvent } from 'react';
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
const MAX_BULK_CONSENT_SELECTION = 100;

export function RecordsPage({ kind, title, eyebrow }: RecordPageProps) {
  const [search, setSearch] = useState('');
  const [consentFilter, setConsentFilter] = useState<ConsentFilter>('ALL');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const [customerToDelete, setCustomerToDelete] = useState<{ id: string; name: string; phone: string }>();
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([]);
  const [bulkOptInStatus, setBulkOptInStatus] = useState<'OPTED_IN' | 'OPTED_OUT'>();
  const [consentImportFile, setConsentImportFile] = useState<File>();
  const [consentImportConfirmed, setConsentImportConfirmed] = useState(false);
  const [consentImportBusy, setConsentImportBusy] = useState(false);
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
      await Promise.all([
        client.invalidateQueries({ queryKey: ['customers'] }),
        client.invalidateQueries({ queryKey: ['bulk-campaigns'] }),
        client.invalidateQueries({ queryKey: ['bulk-campaign'] }),
      ]);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Unable to update customer consent.'),
  });
  const updateOptInBulk = useMutation({
    mutationFn: async ({ ids, status }: { ids: string[]; status: 'OPTED_IN' | 'OPTED_OUT' }) =>
      api.patch<ApiResponse<{ matchedCount: number; updatedCount: number }>>('/customers/opt-in/bulk', {
        ids,
        status,
        source:
          status === 'OPTED_IN'
            ? `Bulk opt-in recorded by ${user?.email ?? 'workspace representative'} after consent verification`
            : `Bulk opt-out recorded by ${user?.email ?? 'workspace representative'} in the admin dashboard`,
      }),
    onSuccess: async (response, { status }) => {
      const count = response.data.data.matchedCount;
      setSelectedCustomerIds([]);
      setBulkOptInStatus(undefined);
      setNotice(`${count} selected customer${count === 1 ? '' : 's'} recorded as ${status === 'OPTED_IN' ? 'opted in' : 'opted out'}.`);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['customers'] }),
        client.invalidateQueries({ queryKey: ['bulk-campaigns'] }),
        client.invalidateQueries({ queryKey: ['bulk-campaign'] }),
      ]);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Unable to update selected customer consent.'),
  });
  const deleteCustomer = useMutation({
    mutationFn: async ({ id }: { id: string; name: string }) => api.delete(`/customers/${id}`),
    onSuccess: async (_response, { id, name }) => {
      setCustomerToDelete(undefined);
      setSelectedCustomerIds((current) => current.filter((selectedId) => selectedId !== id));
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

  async function importConsentedCustomers(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!consentImportFile || !consentImportConfirmed) return;
    const form = event.currentTarget;
    setConsentImportBusy(true);
    setNotice('');
    try {
      const contentType = consentImportFile.name.toLowerCase().endsWith('.csv')
        ? 'text/csv'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const response = await api.post<
        ApiResponse<{
          created: number;
          updated: number;
          skippedOptedOut: number;
          skippedAlreadyOptedIn: number;
          skippedAmbiguous: number;
          duplicateRows: number;
        }>
      >('/customers/import', consentImportFile, {
        headers: { 'Content-Type': contentType, 'X-Consent-Verified': 'true' },
      });
      const { created, updated, skippedOptedOut, skippedAlreadyOptedIn, skippedAmbiguous, duplicateRows } =
        response.data.data;
      setNotice(
        `Consent import complete: ${created} new, ${updated} updated, ${skippedAlreadyOptedIn} already opted-in contacts skipped, ${skippedAmbiguous} ambiguous contacts skipped, ${skippedOptedOut} opted-out contacts preserved, ${duplicateRows} duplicate rows skipped.`,
      );
      setConsentImportFile(undefined);
      setConsentImportConfirmed(false);
      form.reset();
      await client.invalidateQueries({ queryKey: ['customers'] });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to import consent records.');
    } finally {
      setConsentImportBusy(false);
    }
  }

  async function downloadConsentSample(): Promise<void> {
    try {
      const response = await api.get('/customers/import-sample.xlsx', { responseType: 'blob' });
      const url = URL.createObjectURL(response.data as Blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'ncut-consented-contacts-sample.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to download the Excel sample.');
    }
  }

  const columns =
    kind === 'customers'
      ? ['selection', 'profileName', 'phoneNumber', 'optInStatus', 'updatedAt']
      : kind === 'leads'
        ? ['customerId', 'status', 'assignedSalesPerson', 'createdAt']
        : ['customerId', 'status', 'currentStep', 'lastMessageAt'];
  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPageCustomerIds =
    kind === 'customers' ? (query.data?.items ?? []).map((record, row) => String(record._id ?? row)) : [];
  const currentPageSelected =
    currentPageCustomerIds.length > 0 && currentPageCustomerIds.every((id) => selectedCustomerIds.includes(id));

  function toggleCurrentPageSelection(): void {
    setSelectedCustomerIds((current) => {
      const selected = new Set(current);
      for (const id of currentPageCustomerIds) {
        if (currentPageSelected) selected.delete(id);
        else selected.add(id);
      }
      return [...selected];
    });
  }

  function toggleCustomerSelection(id: string): void {
    setSelectedCustomerIds((current) =>
      current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id],
    );
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          <p>
            {kind === 'customers'
              ? 'New contacts stay UNKNOWN until opt-in is verified. Record consent before sending business-initiated messages.'
              : 'Find customer records and review their WhatsApp activity.'}
          </p>
        </div>
      </div>
      {notice && (
        <div
          className={`alert ${updateOptIn.isError || updateOptInBulk.isError || deleteCustomer.isError ? 'error' : ''}`}
          role="status"
        >
          {notice}
          <button type="button" onClick={() => setNotice('')} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      )}
      {kind === 'customers' && (
        <form className="panel" onSubmit={(event) => void importConsentedCustomers(event)}>
          <div className="eyebrow">CUSTOMER CONSENT IMPORT</div>
          <h2>Import opted-in contacts</h2>
          <p>
            Upload a CSV/XLSX with Phone Number, Consent Status, and Consent Source columns. Each row must
            state OPTED_IN and include the actual consent source. Customer Name and Consent Date are optional.
            Existing opted-in contacts are skipped, and existing opt-outs are preserved and excluded.
          </p>
          <button type="button" className="text-button" onClick={() => void downloadConsentSample()}>
            Download Excel sample
          </button>
          <label className="campaign-file-label">
            Consent spreadsheet
            <input
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
              onChange={(event) => setConsentImportFile(event.target.files?.[0])}
            />
            <span className="form-hint">Up to 500 contacts and 5 MB.</span>
          </label>
          <label className="consent-import-confirmation">
            <input
              type="checkbox"
              checked={consentImportConfirmed}
              onChange={(event) => setConsentImportConfirmed(event.target.checked)}
            />{' '}
            <span>I verified that every listed person explicitly consented to receive WhatsApp messages.</span>
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={consentImportBusy || !consentImportFile || !consentImportConfirmed}
          >
            {consentImportBusy ? 'Importing consent…' : 'Import contacts and consent'}
          </button>
        </form>
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
                setSelectedCustomerIds([]);
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
                  setSelectedCustomerIds([]);
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
                setSelectedCustomerIds([]);
                setSearch('');
                setConsentFilter('ALL');
                setPage(1);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {kind === 'customers' && selectedCustomerIds.length > 0 && (
          <div className="customer-bulk-toolbar" role="group" aria-label="Bulk consent actions">
            <span aria-live="polite">
              {selectedCustomerIds.length} customer{selectedCustomerIds.length === 1 ? '' : 's'} selected
            </span>
            <div>
              <button
                type="button"
                className="table-action-button"
                disabled={updateOptInBulk.isPending || updateOptIn.isPending}
                onClick={() => setBulkOptInStatus('OPTED_IN')}
              >
                Record opt-in
              </button>
              <button
                type="button"
                className="table-action-button subtle-danger"
                disabled={updateOptInBulk.isPending || updateOptIn.isPending}
                onClick={() => setBulkOptInStatus('OPTED_OUT')}
              >
                Opt out
              </button>
              <button
                type="button"
                className="table-reset-button"
                onClick={() => setSelectedCustomerIds([])}
              >
                Clear selection
              </button>
            </div>
          </div>
        )}
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
                {kind === 'customers' && (
                  <th className="customer-select-heading">
                    <input
                      type="checkbox"
                      aria-label="Select all customers on this page"
                      checked={currentPageSelected}
                      disabled={
                        currentPageCustomerIds.length === 0 ||
                        query.isLoading ||
                        (!currentPageSelected &&
                          new Set([...selectedCustomerIds, ...currentPageCustomerIds]).size >
                            MAX_BULK_CONSENT_SELECTION)
                      }
                      title={`Bulk consent updates are limited to ${MAX_BULK_CONSENT_SELECTION} customers at a time`}
                      onChange={toggleCurrentPageSelection}
                    />
                  </th>
                )}
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
                    {kind === 'customers' && (
                      <td className="customer-select-cell">
                        <input
                          type="checkbox"
                          aria-label={`Select ${displayName}`}
                          checked={selectedCustomerIds.includes(id)}
                          disabled={
                            !selectedCustomerIds.includes(id) &&
                            selectedCustomerIds.length >= MAX_BULK_CONSENT_SELECTION
                          }
                          title={
                            selectedCustomerIds.length >= MAX_BULK_CONSENT_SELECTION
                              ? `Bulk consent updates are limited to ${MAX_BULK_CONSENT_SELECTION} customers at a time`
                              : undefined
                          }
                          onChange={() => toggleCustomerSelection(id)}
                        />
                      </td>
                    )}
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
      {bulkOptInStatus && (
        <ConfirmDialog
          title={bulkOptInStatus === 'OPTED_IN' ? 'Record bulk opt-in?' : 'Record bulk opt-out?'}
          message={
            bulkOptInStatus === 'OPTED_IN'
              ? `Only continue if each of the ${selectedCustomerIds.length} selected customers explicitly opted in and you verified the consent source. Record opt-in for all selected customers?`
              : `Record ${selectedCustomerIds.length} selected customers as opted out? They will be excluded from future bulk sends.`
          }
          confirmLabel={bulkOptInStatus === 'OPTED_IN' ? 'Record opt-in' : 'Opt out selected'}
          pendingLabel="Updating…"
          isPending={updateOptInBulk.isPending}
          error={updateOptInBulk.error instanceof Error ? updateOptInBulk.error.message : undefined}
          onCancel={() => setBulkOptInStatus(undefined)}
          onConfirm={() =>
            updateOptInBulk.mutate({ ids: selectedCustomerIds, status: bulkOptInStatus })
          }
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
