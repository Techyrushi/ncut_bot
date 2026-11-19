import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiResponse, PageResult } from '../types/api';
import { useAuth } from '../contexts/AuthContext';

interface RecordPageProps {
  kind: 'customers' | 'conversations' | 'leads';
  title: string;
  eyebrow: string;
}

export function RecordsPage({ kind, title, eyebrow }: RecordPageProps) {
  const [search, setSearch] = useState('');
  const { user } = useAuth();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [kind, search],
    queryFn: async () =>
      (
        await api.get<ApiResponse<PageResult<Record<string, unknown>>>>(`/${kind}`, {
          params: search ? { search } : {},
        })
      ).data.data.items,
  });
  const updateOptIn = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'OPTED_IN' | 'OPTED_OUT' }) =>
      api.patch(`/customers/${id}/opt-in`, {
        status,
        source: `Recorded by ${user?.email ?? 'workspace representative'} in the admin dashboard after consent verification`,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['customers'] });
    },
  });
  const columns =
    kind === 'customers'
      ? ['profileName', 'phoneNumber', 'optInStatus', 'updatedAt']
      : kind === 'leads'
        ? ['customerId', 'status', 'assignedSalesPerson', 'createdAt']
        : ['customerId', 'status', 'currentStep', 'lastMessageAt'];
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          <p>Review and manage WhatsApp customer activity.</p>
        </div>
      </div>
      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">LATEST ACTIVITY</div>
            <h2>{query.data?.length ?? 0} records</h2>
          </div>
          <div className="search-wrap">
            <span>⌕</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
            />
          </div>
        </div>
        {query.isError && (
          <div className="alert error">
            {query.error instanceof Error ? query.error.message : 'Unable to load records.'}
          </div>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column.replace(/[A-Z]/g, (letter) => ` ${letter}`).toUpperCase()}</th>
                ))}
                {kind === 'customers' && <th>CONSENT</th>}
              </tr>
            </thead>
            <tbody>
              {(query.data ?? []).map((record, row) => (
                <tr key={String(record._id ?? row)}>
                  {columns.map((column) => (
                    <td key={column}>
                      {column === 'phoneNumber' && !record.phoneNumber
                        ? formatValue(record.whatsappId)
                        : formatValue(record[column])}
                    </td>
                  ))}
                  {kind === 'customers' && (
                    <td>
                      <button
                        className="text-button"
                        onClick={() => {
                          const status = record.optInStatus === 'OPTED_IN' ? 'OPTED_OUT' : 'OPTED_IN';
                          const consentText =
                            status === 'OPTED_IN'
                              ? 'Only continue if the customer explicitly opted in and you have recorded the source. Record opt-in?'
                              : 'Record this customer as opted out?';
                          if (window.confirm(consentText)) updateOptIn.mutate({ id: String(record._id), status });
                        }}
                      >
                        {record.optInStatus === 'OPTED_IN' ? 'Record opt-out' : 'Record verified opt-in'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {query.data?.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (kind === 'customers' ? 1 : 0)} className="empty-row">
                    Nothing to show yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value.length > 30 ? `${value.slice(0, 27)}…` : value;
  if (typeof value === 'object') {
    const item = value as { profileName?: string; name?: string; phoneNumber?: string; email?: string };
    return item.profileName ?? item.name ?? item.phoneNumber ?? item.email ?? '—';
  }
  return String(value);
}
