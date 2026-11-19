import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import type { ApiResponse, DashboardStats } from '../types/api';

const metrics: Array<{ key: keyof DashboardStats; label: string; note: string; accent: string; icon: string }> = [
  { key: 'totalCustomers', label: 'Total customers', note: 'Customer directory', accent: 'lavender', icon: '◎' },
  { key: 'totalConversations', label: 'Conversations', note: 'N-CUT customer enquiries', accent: 'blue', icon: '◌' },
  { key: 'totalProductSelections', label: 'Product selections', note: 'Unique interests', accent: 'orange', icon: '▧' },
  { key: 'totalLeads', label: 'Sales leads', note: 'Created from handovers', accent: 'green', icon: '↗' },
  { key: 'pendingLeads', label: 'Pending leads', note: 'Awaiting first contact', accent: 'yellow', icon: '◷' },
  { key: 'humanHandovers', label: 'Human handovers', note: 'Active sales conversations', accent: 'pink', icon: '↔' },
];

export function DashboardPage() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
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
      <section className="dashboard-welcome">
        <div className="dashboard-welcome-copy">
          <div className="eyebrow">
            {new Date()
              .toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
              .toUpperCase()}
          </div>
          <h1>{greeting}.</h1>
          <p>N-CUT Abrasives catalogue enquiries and sales activity at a glance.</p>
        </div>
        <div className="dashboard-welcome-actions">
          <span className={`status-pill ${health.data?.status !== 'ok' ? 'warning' : ''}`}>
            <i />
            {health.data?.status === 'ok'
              ? 'Database connected'
              : health.isError
                ? 'Database unavailable'
                : 'Checking system'}
          </span>
          <div className="dashboard-quick-links">
            <Link to="/conversations" className="secondary-button">
              Open customer inbox <span aria-hidden="true">→</span>
            </Link>
            <Link to="/products" className="primary-button">
              Manage products <span>→</span>
            </Link>
          </div>
        </div>
      </section>
      {query.isError && (
        <div className="alert error">
          {query.error instanceof Error ? query.error.message : 'Unable to load dashboard metrics.'}
        </div>
      )}
      <section className="metric-grid">
        {metrics.map((metric) => (
          <article className={`metric-card ${metric.accent}`} key={metric.key}>
            <div className="metric-top">
              <span className="metric-label">{metric.label}</span>
              <span className="metric-icon">{metric.icon}</span>
            </div>
            <strong className="metric-value">{query.isLoading ? '—' : (query.data?.[metric.key] ?? 0)}</strong>
            <span className="metric-note">{metric.note}</span>
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
          <div className="panel-foot">Assign N-CUT customer enquiries promptly to keep conversations moving.</div>
        </article>
        <article className="panel readiness-panel">
          <div className="eyebrow">CHANNEL CONFIGURATION</div>
          <h2>N-CUT WhatsApp channel</h2>
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
        <span>N-CUT ABRASIVES · SALES OVERVIEW</span>
        <span>Metrics refresh automatically every 30 seconds</span>
      </div>
    </div>
  );
}
