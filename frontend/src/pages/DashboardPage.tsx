import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiResponse, DashboardStats } from '../types/api';

const metrics: Array<{ key: keyof DashboardStats; label: string; note: string; accent: string }> = [
  { key: 'totalCustomers', label: 'Total customers', note: 'Opt-in audience', accent: 'lavender' },
  { key: 'totalConversations', label: 'Conversations', note: 'All-time activity', accent: 'blue' },
  { key: 'totalProductSelections', label: 'Product selections', note: 'Unique interests', accent: 'orange' },
  { key: 'totalLeads', label: 'Sales leads', note: 'Created from handovers', accent: 'green' },
  { key: 'pendingLeads', label: 'Pending leads', note: 'Awaiting first contact', accent: 'yellow' },
  { key: 'humanHandovers', label: 'Human handovers', note: 'Active sales conversations', accent: 'pink' },
];

export function DashboardPage() {
  const query = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: async () => (await api.get<ApiResponse<DashboardStats>>('/dashboard/stats')).data.data,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => (await api.get<ApiResponse<{ status: string }>>('/health')).data.data,
  });
  const config = useQuery({
    queryKey: ['whatsapp-config'],
    queryFn: async () =>
      (await api.get<ApiResponse<{ configured: boolean; graphApiVersion: string }>>('/whatsapp/configuration')).data
        .data,
  });
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {new Date()
              .toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
              .toUpperCase()}
          </div>
          <h1>Good afternoon.</h1>
          <p>Here’s what’s happening across your WhatsApp sales channel.</p>
        </div>
        <div className="heading-actions">
          <span className={`status-pill ${health.data?.status !== 'ok' ? 'warning' : ''}`}>
            <i />
            {health.data?.status === 'ok'
              ? 'Database connected'
              : health.isError
                ? 'Database unavailable'
                : 'Checking system'}
          </span>
        </div>
      </div>
      {query.isError && (
        <div className="alert error">
          {query.error instanceof Error ? query.error.message : 'Unable to load dashboard metrics.'}
        </div>
      )}
      <section className="metric-grid">
        {metrics.map((metric, index) => (
          <article className={`metric-card ${metric.accent}`} key={metric.key}>
            <div className="metric-top">
              <span className="metric-label">{metric.label}</span>
              <span className="metric-ordinal">{String(index + 1).padStart(2, '0')}</span>
            </div>
            <strong className="metric-value">{query.isLoading ? '—' : (query.data?.[metric.key] ?? 0)}</strong>
            <span className="metric-note">{metric.note}</span>
            <div className="metric-graph">
              <i style={{ height: `${26 + ((index * 17) % 40)}%` }} />
              <i style={{ height: `${44 + ((index * 11) % 38)}%` }} />
              <i style={{ height: `${32 + ((index * 19) % 45)}%` }} />
              <i style={{ height: `${57 + ((index * 7) % 30)}%` }} />
              <i style={{ height: `${41 + ((index * 13) % 45)}%` }} />
            </div>
          </article>
        ))}
      </section>
      <section className="content-grid">
        <article className="panel pipeline-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">SALES PIPELINE</div>
              <h2>Lead attention</h2>
            </div>
            <span className="panel-tag">LIVE</span>
          </div>
          <div className="pipeline-row">
            <div className="pipeline-icon amber">↗</div>
            <div className="pipeline-copy">
              <strong>New leads</strong>
              <span>Ready for a first response</span>
            </div>
            <strong>{query.data?.pendingLeads ?? '—'}</strong>
          </div>
          <div className="pipeline-row">
            <div className="pipeline-icon blue">◌</div>
            <div className="pipeline-copy">
              <strong>Human handovers</strong>
              <span>Customers waiting with your team</span>
            </div>
            <strong>{query.data?.humanHandovers ?? '—'}</strong>
          </div>
          <div className="panel-foot">Assign leads promptly to keep customer conversations moving.</div>
        </article>
        <article className="panel readiness-panel">
          <div className="eyebrow">CHANNEL CONFIGURATION</div>
          <h2>
            Your catalogue,
            <br />
            always within reach.
          </h2>
          <p>
            Credential presence is checked here; message delivery and webhook subscription must still be verified with
            Meta.
          </p>
          <div className="readiness-line">
            <span>
              <i className={config.data?.configured ? 'ready' : 'warning'} /> WhatsApp configuration
            </span>
            <b>{config.data?.configured ? 'VALUES PRESENT' : config.isLoading ? 'CHECKING' : 'ACTION NEEDED'}</b>
          </div>
          <div className="readiness-line">
            <span>
              <i /> Graph API version
            </span>
            <b>{config.data?.graphApiVersion ?? '—'}</b>
          </div>
        </article>
      </section>
      <div className="dashboard-bottom">
        <span>ORBIT SALES CONSOLE</span>
        <span>METRICS REFRESH ON PAGE LOAD</span>
      </div>
    </div>
  );
}
