import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../services/api';
import type { ApiResponse, PageResult } from '../types/api';

type NotificationConversation = Record<string, unknown> & { _id: string };

const navItems = [
  ['/', 'Overview'],
  ['/products', 'Products'],
  ['/customers', 'Customers'],
  ['/conversations', 'Conversations'],
  ['/bulk-campaigns', 'Bulk messages'],
  ['/leads', 'Leads'],
  ['/whatsapp', 'WhatsApp setup'],
  ['/account-security', 'Account security'],
  ['/logs', 'System logs'],
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationFlash, setNotificationFlash] = useState(false);
  const [pushState, setPushState] = useState<'checking' | 'ready' | 'subscribed' | 'unsupported' | 'disabled' | 'error'>('checking');
  const [pushBusy, setPushBusy] = useState(false);
  const previousUnread = useRef<number | null>(null);
  const channel = useQuery({
    queryKey: ['whatsapp-config'],
    queryFn: async () => (await api.get<ApiResponse<{ configured: boolean }>>('/whatsapp/configuration')).data.data,
  });
  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: async () =>
      (await api.get<ApiResponse<PageResult<NotificationConversation>>>('/conversations?limit=100')).data.data.items,
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });
  const unreadLeads = useQuery({
    queryKey: ['unread-leads-count'],
    enabled: user?.role === 'ADMIN' || user?.role === 'SALES',
    queryFn: async () =>
      (await api.get<ApiResponse<PageResult<NotificationConversation>>>('/leads?unread=true&page=1&limit=1')).data.data.total,
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (user?.role !== 'ADMIN') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPushState('unsupported');
      return;
    }

    let active = true;
    void navigator.serviceWorker
      .register('/service-worker.js', { updateViaCache: 'none' })
      .then(async (registration) => {
        await registration.update();
        const { data } = await api.get<ApiResponse<{ enabled: boolean }>>('/push/configuration');
        if (!active) return;
        if (!data.data.enabled) {
          setPushState('disabled');
          return;
        }
        const subscription = await registration.pushManager.getSubscription();
        setPushState(subscription ? 'subscribed' : 'ready');
      })
      .catch(() => {
        if (active) setPushState('error');
      });

    return () => {
      active = false;
    };
  }, [user?.role]);

  async function togglePushNotifications(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    event.preventDefault();
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const { data } = await api.get<ApiResponse<{ enabled: boolean; publicKey: string }>>('/push/configuration');
      if (!data.data.enabled || !data.data.publicKey) {
        setPushState('disabled');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      if (current) {
        await api.delete('/push/subscriptions', { data: { endpoint: current.endpoint } });
        await current.unsubscribe();
        setPushState('ready');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushState(permission === 'denied' ? 'error' : 'ready');
        return;
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidPublicKey(data.data.publicKey),
      });
      await api.post('/push/subscriptions', subscription.toJSON());
      setPushState('subscribed');
    } catch {
      setPushState('error');
    } finally {
      setPushBusy(false);
    }
  }
  const unread = (conversations.data ?? []).filter((item) => Number(item.unreadCount ?? 0) > 0);
  const unreadTotal = unread.reduce((sum, item) => sum + Number(item.unreadCount ?? 0), 0);
  useEffect(() => {
    if (previousUnread.current !== null && unreadTotal > previousUnread.current) {
      setNotificationFlash(true);
      const timer = window.setTimeout(() => setNotificationFlash(false), 1800);
      previousUnread.current = unreadTotal;
      return () => window.clearTimeout(timer);
    }
    previousUnread.current = unreadTotal;
  }, [unreadTotal]);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/ncut_logo.jpeg" alt="N-CUT Abrasives" />
          <div>
            <strong>N-CUT</strong>
            <span>ABRASIVES SALES</span>
          </div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="nav-list">
          {navItems
            .filter(
              ([path]) =>
                (path !== '/logs' || user?.role === 'ADMIN') &&
                (path !== '/bulk-campaigns' || user?.role === 'ADMIN'),
            )
            .map(([path, label], index) => (
              <NavLink
                key={path}
                to={path}
                end={path === '/'}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <span className="nav-index">{String(index + 1).padStart(2, '0')}</span>
                {label}
                {label === 'Leads' && Number(unreadLeads.data ?? 0) > 0 && (
                  <span className="nav-badge" aria-label={`${unreadLeads.data} unread leads`}>
                    {Number(unreadLeads.data) > 99 ? '99+' : unreadLeads.data}
                  </span>
                )}
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
            <span className="eyebrow">N-CUT ABRASIVES / OPERATIONS</span>
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
            {user?.role === 'ADMIN' && pushState !== 'unsupported' && pushState !== 'disabled' && (
              <button
                type="button"
                className="push-notification-toggle"
                onClick={togglePushNotifications}
                disabled={pushBusy || pushState === 'checking'}
                title={
                  pushState === 'error'
                    ? 'Push notifications need browser permission and HTTPS'
                    : pushState === 'subscribed'
                      ? 'Turn off background notifications'
                      : 'Enable background notifications'
                }
              >
                {pushBusy || pushState === 'checking'
                  ? 'Checking alerts…'
                  : pushState === 'subscribed'
                    ? 'Alerts on'
                    : pushState === 'error'
                      ? 'Alerts unavailable'
                      : 'Enable alerts'}
              </button>
            )}
            <div className="notification-menu">
              <button
                type="button"
                className={`notification-bell ${notificationFlash ? 'is-flashing' : ''}`}
                aria-label={
                  conversations.isError
                    ? 'Message notifications unavailable'
                    : `Notifications${unreadTotal ? `, ${unreadTotal} unread messages` : ''}`
                }
                aria-expanded={notificationsOpen}
                onClick={() => setNotificationsOpen((open) => !open)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.7"
                  />
                </svg>
                {unreadTotal > 0 && <span className="notification-count">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
              </button>
              {notificationsOpen && (
                <div className="notification-dropdown">
                  <div className="notification-dropdown-heading">
                    <strong>Messages</strong>
                    <span>{unreadTotal ? `${unreadTotal} unread` : 'All caught up'}</span>
                  </div>
                  {conversations.isError ? (
                    <p className="notification-empty" role="alert">
                      {conversations.error instanceof Error
                        ? conversations.error.message
                        : 'Unable to load message notifications.'}
                    </p>
                  ) : unread.length ? (
                    unread.slice(0, 8).map((conversation) => {
                      const customer = conversation.customerId;
                      const customerRecord =
                        customer && typeof customer === 'object' ? (customer as Record<string, unknown>) : {};
                      const name = String(
                        customerRecord.profileName ??
                          customerRecord.name ??
                          customerRecord.phoneNumber ??
                          'Customer',
                      );
                      return (
                        <button
                          key={conversation._id}
                          className="notification-item"
                          onClick={() => {
                            setNotificationsOpen(false);
                            navigate(`/conversations?conversation=${encodeURIComponent(conversation._id)}`);
                          }}
                        >
                          <span className="notification-item-avatar">{name.slice(0, 1).toUpperCase()}</span>
                          <span>
                            <strong>{name}</strong>
                            <small>
                              {Number(conversation.unreadCount)} new message
                              {Number(conversation.unreadCount) === 1 ? '' : 's'}
                            </small>
                          </span>
                          <span className="notification-unread-dot" />
                        </button>
                      );
                    })
                  ) : (
                    <p className="notification-empty">New customer messages will appear here.</p>
                  )}
                  <button
                    className="notification-footer"
                    onClick={() => {
                      setNotificationsOpen(false);
                      navigate('/conversations');
                    }}
                  >
                    Open conversations
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="page-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function decodeVapidPublicKey(value: string): ArrayBuffer {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const buffer = new ArrayBuffer(decoded.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return buffer;
}
