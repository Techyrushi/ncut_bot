import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiResponse, PageResult } from '../types/api';
import { ConfirmDialog } from '../components/ConfirmDialog';

type ActivityLogEntry = {
  _id: string;
  source: 'USER' | 'SYSTEM';
  action: string;
  summary?: string;
  resourceType?: string;
  resourceId?: string;
  actorId?: { name: string; email: string; role: string } | string;
  actorRole?: string;
  statusCode?: number;
  occurredAt: string;
};

type HealthStatus = { status: string; database: string; timestamp: string };
type SourceFilter = 'ALL' | ActivityLogEntry['source'];

export function SystemLogsPage() {
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<SourceFilter>('ALL');
  const [page, setPage] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const logs = useQuery({
    queryKey: ['activity-logs', page, search, source],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: '25' });
      if (search.trim()) params.set('search', search.trim());
      if (source !== 'ALL') params.set('source', source);
      return (await api.get<ApiResponse<PageResult<ActivityLogEntry>>>(`/logs?${params}`)).data.data;
    },
  });
  const health = useQuery({
    queryKey: ['api-health'],
    queryFn: async () => (await api.get<ApiResponse<HealthStatus>>('/health')).data.data,
    refetchInterval: 30_000,
  });
  const clearHistory = useMutation({
    mutationFn: async () => (await api.delete<ApiResponse<{ deletedCount: number }>>('/logs')).data.data,
    onSuccess: async ({ deletedCount }) => {
      setConfirmClear(false);
      setNotice(`Cleared ${deletedCount} activity record${deletedCount === 1 ? '' : 's'}. This action is recorded in the audit trail.`);
      setPage(1);
      await client.invalidateQueries({ queryKey: ['activity-logs'] });
    },
  });
  const totalPages = Math.max(1, Math.ceil((logs.data?.total ?? 0) / (logs.data?.limit ?? 25)));
  const clearError = clearHistory.error instanceof Error ? clearHistory.error.message : '';

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SYSTEM / OBSERVABILITY</div>
          <h1>System logs</h1>
          <p>Review recorded admin activity and service events. Sensitive request contents are never stored here.</p>
        </div>
        <div className="logs-page-actions">
          <button className="secondary-button" type="button" onClick={() => void logs.refetch()}>
            Refresh activity
          </button>
          <button
            className="secondary-button logs-clear-button"
            type="button"
            disabled={!logs.data?.total || clearHistory.isPending}
            title="Permanently remove all activity log records"
            onClick={() => {
              clearHistory.reset();
              setConfirmClear(true);
            }}
          >
            Clear history
          </button>
        </div>
      </div>
      {notice && <div className="alert" role="status">{notice}<button type="button" onClick={() => setNotice('')}>×</button></div>}

      <section className="logs-status-row">
        <div className="logs-status-card">
          <span className="eyebrow">API STATUS</span>
          <strong className={health.data?.status === 'ok' ? 'success-text' : 'danger-text'}>
            {health.isLoading ? 'Checking…' : health.data?.status === 'ok' ? 'Operational' : 'Unavailable'}
          </strong>
          {health.data?.timestamp && <span>Last checked {new Date(health.data.timestamp).toLocaleTimeString()}</span>}
          {health.isError && <span role="alert">Health check failed.</span>}
        </div>
        <div className="logs-status-card">
          <span className="eyebrow">DATABASE</span>
          <strong className={health.data?.database === 'connected' ? 'success-text' : 'danger-text'}>
            {health.isLoading ? 'Checking…' : health.data?.database ?? 'Unavailable'}
          </strong>
          <span>Persistent activity history</span>
        </div>
        <div className="logs-status-card">
          <span className="eyebrow">RECORDED EVENTS</span>
          <strong>{logs.data?.total ?? '—'}</strong>
          <span>{logs.isLoading ? 'Loading activity…' : 'Matching the current filters'}</span>
        </div>
      </section>

      <section className="panel table-panel">
        <div className="customer-table-heading logs-activity-heading">
          <div>
            <div className="eyebrow">AUDIT TRAIL</div>
            <h2>Recent activity</h2>
          </div>
        </div>
        <div className="table-toolbar">
          <label className="table-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search activity logs"
              placeholder="Search events or resources"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="filter-control">
            Event source
            <select
              value={source}
              onChange={(event) => {
                setSource(event.target.value as SourceFilter);
                setPage(1);
              }}
            >
              <option value="ALL">All sources</option>
              <option value="USER">User activity</option>
              <option value="SYSTEM">System events</option>
            </select>
          </label>
        </div>
        {logs.isError && (
          <div className="table-loading danger-text" role="alert">
            {logs.error instanceof Error ? logs.error.message : 'Unable to load activity logs.'}
          </div>
        )}
        {logs.isLoading ? (
          <div className="table-loading">Loading activity records…</div>
        ) : (
          <div className="table-scroll">
            <table className="admin-data-table">
              <thead>
                <tr>
                  <th>TIME</th>
                  <th>EVENT</th>
                  <th>SOURCE</th>
                  <th>ACTOR</th>
                  <th>RESOURCE</th>
                  <th>RESULT</th>
                </tr>
              </thead>
              <tbody>
                {logs.data?.items.length ? (
                  logs.data.items.map((entry) => {
                      const actor = entry.actorId && typeof entry.actorId === 'object' ? entry.actorId : undefined;
                    return (
                      <tr key={entry._id}>
                        <td>{new Date(entry.occurredAt).toLocaleString()}</td>
                        <td className="log-event-cell">
                          <strong>{entry.action}</strong>
                          {entry.summary && <span>{entry.summary}</span>}
                        </td>
                        <td>
                          <span className={`log-source-chip ${entry.source.toLowerCase()}`}>{entry.source}</span>
                        </td>
                        <td>
                          {actor ? (
                            <>
                              <strong>{actor.name}</strong>
                              <span className="log-secondary">{actor.email}</span>
                            </>
                          ) : (
                            entry.actorRole ?? 'Service'
                          )}
                        </td>
                        <td>
                          {entry.resourceType ?? '—'}
                          {entry.resourceId && <span className="log-secondary">{entry.resourceId}</span>}
                        </td>
                        <td>
                          {entry.statusCode ? (
                            <span className={`log-result ${entry.statusCode >= 400 ? 'failed' : ''}`}>
                              {entry.statusCode} · {entry.statusCode >= 400 ? 'Failed' : 'Success'}
                            </span>
                          ) : (
                            'Recorded'
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="empty-row" colSpan={6}>
                      {logs.isError
                        ? 'Activity history is unavailable.'
                        : 'No activity matches these filters yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-pagination">
          <span>
            {logs.data?.total ?? 0} event{logs.data?.total === 1 ? '' : 's'}
          </span>
          <div>
            <button
              className="secondary-button"
              disabled={page <= 1 || logs.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <span>
              Page {page} of {totalPages}
            </span>
            <button
              className="secondary-button"
              disabled={page >= totalPages || logs.isFetching}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              Next
            </button>
          </div>
        </div>
      </section>
      {confirmClear && (
        <ConfirmDialog
          title="Clear all activity history?"
          message={`This permanently deletes all ${logs.data?.total ?? 0} activity records from the database, including records outside the current filters. The clear action itself will be retained in the audit trail. Campaign delivery history is not affected.`}
          confirmLabel="Clear all history"
          pendingLabel="Clearing…"
          isPending={clearHistory.isPending}
          error={clearError || undefined}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => clearHistory.mutate()}
        />
      )}
    </div>
  );
}
