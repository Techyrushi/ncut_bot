import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../services/api';
import type { ApiResponse } from '../types/api';

const navItems = [
  ['/', 'Overview'],
  ['/products', 'Products'],
  ['/customers', 'Customers'],
  ['/conversations', 'Conversations'],
  ['/leads', 'Leads'],
  ['/sales-team', 'Sales team'],
  ['/templates', 'Message templates'],
  ['/whatsapp', 'WhatsApp setup'],
  ['/automation', 'Automation'],
  ['/logs', 'System logs'],
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const channel = useQuery({
    queryKey: ['whatsapp-config'],
    queryFn: async () => (await api.get<ApiResponse<{ configured: boolean }>>('/whatsapp/configuration')).data.data,
  });
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">O</div>
          <div>
            <strong>orbit</strong>
            <span>SALES CONSOLE</span>
          </div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="nav-list">
          {navItems.map(([path, label], index) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <span className="nav-index">{String(index + 1).padStart(2, '0')}</span>
              {label}
              {label === 'Leads' && <span className="nav-dot" />}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="avatar">{user?.name.slice(0, 1).toUpperCase()}</div>
          <div className="user-meta">
            <strong>{user?.name}</strong>
            <span>{user?.role === 'ADMIN' ? 'Administrator' : 'Sales representative'}</span>
          </div>
          <button
            className="icon-button"
            aria-label="Log out"
            onClick={() => {
              logout();
              navigate('/login');
            }}
          >
            ↗
          </button>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">WORKSPACE / OPERATIONS</span>
            <strong>Product catalogue & sales</strong>
          </div>
          <div className="topbar-right">
            <span className={`live-indicator ${channel.data?.configured ? 'ready' : 'warning'}`} />
            {channel.isLoading
              ? 'Checking WhatsApp'
              : channel.data?.configured
                ? 'WhatsApp configured'
                : 'Setup needed'}
            <span className="topbar-separator">•</span>{' '}
            {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </div>
        </header>
        <div className="page-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
