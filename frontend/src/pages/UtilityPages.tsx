import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiResponse } from '../types/api';
import { useAuth } from '../contexts/AuthContext';

export function UtilityPage({ title, eyebrow, description }: { title: string; eyebrow: string; description: string }) {
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      <section className="panel utility-panel">
        <div className="eyebrow">WORKSPACE CONFIGURATION</div>
        <h2>Available to administrators</h2>
        <p>
          Management endpoints and policy-aware service integrations are in place. Configure secrets on the backend;
          credentials are never sent to this page.
        </p>
        <span className="status-pill">
          <i /> Protected configuration surface
        </span>
      </section>
    </div>
  );
}

export function AutomationSettingsPage() {
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKFLOW / RULES</div>
          <h1>Automation settings</h1>
          <p>Review the active conversation rules that protect customer experience and Meta policy compliance.</p>
        </div>
      </div>
      <section className="panel automation-rules">
        {[
          ['Welcome', 'A first inbound message starts the saved welcome message and product/team options.'],
          [
            'Catalogue',
            '12 requested categories are paginated; product content is read from active catalogue records.',
          ],
          [
            'Interest trigger',
            'The third distinct product selection triggers a single sales-interest prompt per conversation.',
          ],
          [
            'Session expiry',
            'Seven days without a customer message closes the automation session and resets discovery on return.',
          ],
          [
            'Human handover',
            'A sales request creates one lead and pauses automated product replies for that conversation.',
          ],
          [
            'Messaging window',
            'Free-form WhatsApp messages require an active 24-hour service window; outside it, use an approved template.',
          ],
        ].map(([label, description], index) => (
          <div className="automation-rule" key={label}>
            <span className="metric-ordinal">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>{label}</strong>
              <p>{description}</p>
            </div>
            <span className="status-chip on">ACTIVE</span>
          </div>
        ))}
        <p className="small muted">
          Welcome wording and the click-to-chat business number are editable in WhatsApp setup. The policy and trigger
          rules are intentionally fixed in code to preserve the approved workflow.
        </p>
      </section>
    </div>
  );
}

export function WhatsAppSetupPage() {
  const { user } = useAuth();
  const [number, setNumber] = useState('');
  const [message, setMessage] = useState('Hello, I would like to explore your products.');
  const [welcomeMessage, setWelcomeMessage] = useState(
    '👋 Thank you for connecting with us!\n\nExplore our range of abrasive and finishing products.',
  );
  const digits = number.replace(/\D/g, '');
  const prefilledMessage = message.trim();
  const chatUrl = digits
    ? `https://wa.me/${digits}${prefilledMessage ? `?text=${encodeURIComponent(prefilledMessage)}` : ''}`
    : '';
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: async () =>
      (await api.get<ApiResponse<{ businessPhoneNumber: string; welcomeMessage: string }>>('/settings/workspace')).data
        .data,
  });
  const config = useQuery({
    queryKey: ['whatsapp-config'],
    queryFn: async () =>
      (
        await api.get<
          ApiResponse<{
            configured: boolean;
            sendConfigured: boolean;
            webhookConfigured: boolean;
            accessTokenConfigured: boolean;
            graphApiVersion: string;
            phoneNumberIdConfigured: boolean;
            businessAccountConfigured: boolean;
            appSecretConfigured: boolean;
            verifyTokenConfigured: boolean;
            webhookEndpoint: string;
          }>
        >('/whatsapp/configuration')
      ).data.data,
  });
  const testConnection = useMutation({
    mutationFn: async () =>
      (
        await api.post<
          ApiResponse<{
            id?: string;
            status?: string;
            displayPhoneNumber?: string;
            verifiedName?: string;
          }>
        >('/whatsapp/configuration/test-connection')
      ).data.data,
  });
  const saveSettings = useMutation({
    mutationFn: async () => api.patch('/settings/workspace', { businessPhoneNumber: number, welcomeMessage }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspace-settings'] });
    },
  });
  function downloadQr(): void {
    const svg = document.getElementById('whatsapp-qr');
    if (!(svg instanceof SVGSVGElement)) return;
    const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'whatsapp-catalogue-qr.svg';
    anchor.click();
    URL.revokeObjectURL(url);
  }
  useEffect(() => {
    if (settings.data) {
      setNumber(settings.data.businessPhoneNumber);
      setWelcomeMessage(settings.data.welcomeMessage);
    }
  }, [settings.data]);
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CHANNEL / ENTRY POINT</div>
          <h1>WhatsApp setup</h1>
          <p>Create a click-to-chat QR code for your business number.</p>
        </div>
      </div>
      <section className="panel config-check">
        <div>
          <div className="eyebrow">BACKEND CONFIGURATION</div>
          <strong>
            {config.data?.configured ? 'Required credentials are present' : 'WhatsApp setup is incomplete'}
          </strong>
        </div>
        <span className={`status-chip ${config.data?.configured ? 'on' : 'off'}`}>
          {config.isLoading ? 'CHECKING' : config.data?.configured ? 'CONFIGURED' : 'ACTION NEEDED'}
        </span>
        <div className="config-checklist">
          {[
            ['Access token', config.data?.accessTokenConfigured],
            ['Phone number ID', config.data?.phoneNumberIdConfigured],
            ['Business account ID', config.data?.businessAccountConfigured],
            ['App secret', config.data?.appSecretConfigured],
            ['Verify token', config.data?.verifyTokenConfigured],
          ].map(([label, enabled]) => (
            <span key={String(label)}>
              {enabled ? '✓' : '○'} {label}
            </span>
          ))}
        </div>
        <div className="connection-actions">
          <button
            className="secondary-button"
            disabled={!config.data?.sendConfigured || testConnection.isPending}
            onClick={() => testConnection.mutate()}
          >
            {testConnection.isPending ? 'Checking Meta…' : 'Test Meta connection'}
          </button>
          {testConnection.data && (
            <span className="small success-text">
              Meta accepted the credentials · {testConnection.data.status ?? 'Status unavailable'}
              {testConnection.data.verifiedName ? ` · ${testConnection.data.verifiedName}` : ''}
              {testConnection.data.displayPhoneNumber ? ` · ${testConnection.data.displayPhoneNumber}` : ''}
            </span>
          )}
          {testConnection.isError && (
            <span className="small danger-text">
              {testConnection.error instanceof Error ? testConnection.error.message : 'Meta connection check failed.'}
            </span>
          )}
        </div>
        {!config.data?.sendConfigured && (
          <div className="alert error">
            Outbound messages are blocked until a valid rotated access token and the sender phone-number ID are set in
            the backend environment.
          </div>
        )}
        {!config.data?.webhookConfigured && (
          <div className="alert error">
            Inbound automation is blocked until WHATSAPP_APP_SECRET (Meta Developers → App settings → Basic) and
            WHATSAPP_VERIFY_TOKEN are set. The verify token must exactly match Meta's callback configuration.
          </div>
        )}
        <p className="small muted">
          Testing performs a read-only phone-number metadata request. It does not send a WhatsApp message or confirm
          webhook subscription. Access tokens and secrets are never displayed here.
        </p>
      </section>
      <section className="panel webhook-setup">
        <div className="eyebrow">META WEBHOOK</div>
        <h2>Callback setup</h2>
        <p>
          Register this callback in your Meta app, use the same verify token as the backend environment, and subscribe
          the WhatsApp product to the <strong>messages</strong> field.
        </p>
        <code>{config.data?.webhookEndpoint ?? 'Loading callback URL…'}</code>
        <p className="small muted">
          Meta requires a publicly reachable HTTPS callback. A localhost URL is suitable only for local development
          through a secure tunnel. Set APP_URL to the public API origin before configuring the callback.
        </p>
      </section>
      <div className="content-grid qr-grid">
        <section className="panel">
          <div className="eyebrow">BUSINESS CONTACT</div>
          <h2>Conversation entry point</h2>
          <p className="muted">
            Scanning opens WhatsApp. Customers must send their opening message before automation can respond.
          </p>
          <label>
            Business phone number
            <input
              disabled={user?.role !== 'ADMIN'}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="+15551234567"
              inputMode="tel"
            />
          </label>
          <label>
            QR prefilled message
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <div className="small muted">
            Use international format. The QR does not itself constitute customer opt-in.
          </div>
          <div className="section-rule" />
          <div className="eyebrow">AUTOMATION / WELCOME</div>
          <label>
            Welcome message
            <textarea
              disabled={user?.role !== 'ADMIN'}
              value={welcomeMessage}
              onChange={(e) => setWelcomeMessage(e.target.value)}
            />
          </label>
          {user?.role === 'ADMIN' && (
            <button className="primary-button" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
              {saveSettings.isPending ? 'Saving…' : 'Save workspace settings'} <span>→</span>
            </button>
          )}
          {saveSettings.isSuccess && <span className="small success-text">Workspace settings saved.</span>}
          {saveSettings.isError && (
            <span className="small danger-text">
              {saveSettings.error instanceof Error ? saveSettings.error.message : 'Unable to save settings.'}
            </span>
          )}
        </section>
        <section className="panel qr-preview">
          <div className="eyebrow">LIVE PREVIEW</div>
          <div className="qr-box">
            {chatUrl ? (
              <QRCodeSVG id="whatsapp-qr" value={chatUrl} size={210} level="M" />
            ) : (
              <div className="qr-empty">
                Enter a number
                <br />
                to generate your QR
              </div>
            )}
          </div>
          <strong>Scan to chat</strong>
          <span className="muted">Your catalogue starts in WhatsApp</span>
          {chatUrl && (
            <button className="primary-button download-link" onClick={downloadQr}>
              ↓ Download QR
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
