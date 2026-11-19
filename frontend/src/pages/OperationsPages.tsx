import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiResponse, PageResult } from '../types/api';
import { useAuth } from '../contexts/AuthContext';

type BasicRecord = Record<string, unknown> & { _id: string };

export function TeamPage() {
  const client = useQueryClient();
  const { user } = useAuth();
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const people = useQuery({
    queryKey: ['team'],
    queryFn: async () => (await api.get<ApiResponse<Array<BasicRecord>>>('/team')).data.data,
  });
  const create = useMutation({
    mutationFn: async () => api.post('/team', form),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['team'] });
      setForm({ name: '', email: '', password: '' });
      setNotice('Sales representative added.');
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Unable to add representative.'),
  });
  const deactivate = useMutation({
    mutationFn: async (id: string) => api.patch(`/team/${id}`, { isActive: false }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['team'] });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PEOPLE / ACCESS</div>
          <h1>Sales team</h1>
          <p>Manage the representatives who follow up on sales handovers.</p>
        </div>
      </div>
      {notice && (
        <div className="alert">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
      <div className="content-grid operations-grid">
        {user?.role === 'ADMIN' && (
          <form className="panel product-form" onSubmit={submit}>
            <div className="eyebrow">INVITE REPRESENTATIVE</div>
            <h2>New team member</h2>
            <label>
              Full name
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              Work email
              <input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label>
              Temporary password
              <input
                type="password"
                minLength={12}
                required
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            <p className="small muted">Provide the password securely out of band. Minimum 12 characters.</p>
            <button className="primary-button" disabled={create.isPending}>
              Add representative <span>→</span>
            </button>
          </form>
        )}
        <section className="panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">ACCESS ROSTER</div>
              <h2>{people.data?.length ?? 0} representatives</h2>
            </div>
          </div>
          {(people.data ?? []).map((person) => (
            <div className="pipeline-row" key={person._id}>
              <div className="avatar">{String(person.name ?? '?').slice(0, 1)}</div>
              <div className="pipeline-copy">
                <strong>{String(person.name)}</strong>
                <span>{String(person.email)}</span>
              </div>
              <span className={`status-chip ${person.isActive === true ? 'on' : 'off'}`}>
                {person.isActive === true ? 'ACTIVE' : 'DISABLED'}
              </span>
              {user?.role === 'ADMIN' && person.isActive === true && (
                <button className="text-button danger-text" onClick={() => deactivate.mutate(person._id)}>
                  Disable
                </button>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

export function TemplatesPage() {
  const client = useQueryClient();
  const { user } = useAuth();
  const [form, setForm] = useState({ name: '', languageCode: 'en_US', category: 'UTILITY' });
  const [notice, setNotice] = useState('');
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: async () => (await api.get<ApiResponse<Array<BasicRecord>>>('/templates')).data.data,
  });
  const create = useMutation({
    mutationFn: async () => api.post('/templates', { ...form, components: [] }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['templates'] });
      setForm({ name: '', languageCode: 'en_US', category: 'UTILITY' });
      setNotice('Template record added. Confirm its status in WhatsApp Manager before sending.');
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Unable to save template.'),
  });
  const update = useMutation({
    mutationFn: async ({ id, metaStatus }: { id: string; metaStatus: string }) =>
      api.patch(`/templates/${id}/status`, { metaStatus }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Unable to update template status.'),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MESSAGING / POLICY</div>
          <h1>Message templates</h1>
          <p>Register and track approved Meta templates for business-initiated messaging.</p>
        </div>
      </div>
      {notice && (
        <div className="alert">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
      {user?.role === 'ADMIN' && (
        <form className="panel template-form" onSubmit={submit}>
          <div className="eyebrow">REGISTER META TEMPLATE</div>
          <div className="form-grid">
            <label>
              Template name
              <input
                required
                pattern="[a-z0-9_]+"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Language code
              <input
                required
                value={form.languageCode}
                onChange={(e) => setForm({ ...form, languageCode: e.target.value })}
              />
            </label>
            <label>
              Category
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option>UTILITY</option>
                <option>MARKETING</option>
                <option>AUTHENTICATION</option>
              </select>
            </label>
          </div>
          <button className="primary-button" disabled={create.isPending}>
            Add template <span>→</span>
          </button>
        </form>
      )}
      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">TEMPLATE REGISTRY</div>
            <h2>{templates.data?.length ?? 0} templates</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>NAME</th>
                <th>LANGUAGE</th>
                <th>CATEGORY</th>
                <th>META STATUS</th>
                <th>UPDATE STATUS</th>
              </tr>
            </thead>
            <tbody>
              {(templates.data ?? []).map((template) => (
                <tr key={template._id}>
                  <td>
                    <strong>{String(template.name)}</strong>
                  </td>
                  <td>{String(template.languageCode)}</td>
                  <td>{String(template.category)}</td>
                  <td>
                    <span className={`status-chip ${template.metaStatus === 'APPROVED' ? 'on' : 'off'}`}>
                      {String(template.metaStatus)}
                    </span>
                  </td>
                  <td>
                    {user?.role === 'ADMIN' ? (
                      <select
                        value={String(template.metaStatus)}
                        onChange={(e) => update.mutate({ id: template._id, metaStatus: e.target.value })}
                      >
                        <option>PENDING</option>
                        <option>APPROVED</option>
                        <option>REJECTED</option>
                        <option>PAUSED</option>
                      </select>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
              {templates.data?.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-row">
                    No template records registered.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="small muted pad-inline">
          Only mark templates approved after verifying the exact name and language in WhatsApp Manager.
        </p>
      </section>
    </div>
  );
}

export function LeadsPage() {
  const client = useQueryClient();
  const { user } = useAuth();
  const leads = useQuery({
    queryKey: ['leads'],
    queryFn: async () => (await api.get<ApiResponse<PageResult<BasicRecord>>>('/leads')).data.data.items,
  });
  const team = useQuery({
    queryKey: ['team'],
    enabled: user?.role === 'ADMIN',
    queryFn: async () => (await api.get<ApiResponse<Array<BasicRecord>>>('/team')).data.data,
  });
  const update = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => api.patch(`/leads/${id}/status`, { status }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['leads'] });
      await client.invalidateQueries({ queryKey: ['dashboard-stats'] });
    },
  });
  const assign = useMutation({
    mutationFn: async ({ id, userId }: { id: string; userId: string }) => api.patch(`/leads/${id}/assign`, { userId }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['leads'] });
    },
  });
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SALES / PIPELINE</div>
          <h1>Leads</h1>
          <p>Prioritize customer requests and record sales outcomes.</p>
        </div>
      </div>
      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">FOLLOW-UP QUEUE</div>
            <h2>{leads.data?.length ?? 0} leads</h2>
          </div>
        </div>
        {leads.isError && (
          <div className="alert error">
            {leads.error instanceof Error ? leads.error.message : 'Unable to load leads.'}
          </div>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>CUSTOMER</th>
                <th>PRODUCTS</th>
                <th>ASSIGNEE</th>
                <th>CREATED</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {(leads.data ?? []).map((lead) => (
                <tr key={lead._id}>
                  <td>{display(lead.customerId)}</td>
                  <td>{displayMany(lead.selectedProducts)}</td>
                  <td>
                    {user?.role === 'ADMIN' ? (
                      <select
                        aria-label="Assign sales representative"
                        value={getId(lead.assignedSalesPerson)}
                        onChange={(e) => e.target.value && assign.mutate({ id: lead._id, userId: e.target.value })}
                      >
                        <option value="">Unassigned</option>
                        {(team.data ?? [])
                          .filter((person) => person.isActive === true)
                          .map((person) => (
                            <option key={person._id} value={person._id}>
                              {String(person.name)}
                            </option>
                          ))}
                      </select>
                    ) : (
                      display(lead.assignedSalesPerson)
                    )}
                  </td>
                  <td>{formatDate(lead.createdAt)}</td>
                  <td>
                    <select
                      value={String(lead.status)}
                      onChange={(e) => update.mutate({ id: lead._id, status: e.target.value })}
                    >
                      <option>NEW</option>
                      <option>CONTACTED</option>
                      <option>QUALIFIED</option>
                      <option>WON</option>
                      <option>LOST</option>
                    </select>
                  </td>
                </tr>
              ))}
              {leads.data?.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-row">
                    No leads yet.
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

export function ConversationsPage() {
  const [selectedId, setSelectedId] = useState('');
  const [reply, setReply] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templateComponents, setTemplateComponents] = useState('[]');
  const client = useQueryClient();
  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => (await api.get<ApiResponse<PageResult<BasicRecord>>>('/conversations')).data.data.items,
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });
  const messages = useQuery({
    queryKey: ['conversation-messages', selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () =>
      (await api.get<ApiResponse<Array<BasicRecord>>>(`/conversations/${selectedId}/messages`)).data.data,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });
  const approvedTemplates = useQuery({
    queryKey: ['approved-message-templates'],
    enabled: Boolean(selectedId),
    queryFn: async () =>
      (await api.get<ApiResponse<BasicRecord[]>>('/templates')).data.data.filter(
        (template) => template.metaStatus === 'APPROVED',
      ),
  });
  const selected = conversations.data?.find((conversation) => conversation._id === selectedId);
  const lastInteraction = selected?.lastInteractionAt ? new Date(String(selected.lastInteractionAt)).getTime() : 0;
  const serviceWindowOpen = lastInteraction > Date.now() - 24 * 60 * 60 * 1000;
  useEffect(() => {
    if (!selectedId && conversations.data?.length) setSelectedId(conversations.data[0]!._id);
  }, [conversations.data, selectedId]);
  const closeConversation = useMutation({
    mutationFn: async () => api.patch(`/conversations/${selectedId}/status`, { status: 'CLOSED' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const sendReply = useMutation({
    mutationFn: async () => {
      const customerId = getId(selected?.customerId);
      if (!customerId) throw new Error('The selected conversation has no customer record.');
      return api.post('/whatsapp/send-message', { customerId, message: reply.trim() });
    },
    onSuccess: async () => {
      setReply('');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['conversation-messages', selectedId] }),
        client.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
    },
  });
  const sendTemplate = useMutation({
    mutationFn: async () => {
      const customerId = getId(selected?.customerId);
      if (!customerId) throw new Error('The selected conversation has no customer record.');
      let components: unknown;
      try {
        components = JSON.parse(templateComponents);
      } catch {
        throw new Error('Template components must be valid JSON.');
      }
      if (
        !Array.isArray(components) ||
        components.some((component) => !component || typeof component !== 'object' || Array.isArray(component))
      ) {
        throw new Error('Template components must be a JSON array of component objects.');
      }
      return api.post('/whatsapp/send-template', { customerId, templateId, components });
    },
    onSuccess: async () => {
      setTemplateId('');
      setTemplateComponents('[]');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['conversation-messages', selectedId] }),
        client.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
    },
  });
  function submitReply(event: FormEvent): void {
    event.preventDefault();
    if (reply.trim()) sendReply.mutate();
  }
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MESSAGING / HISTORY</div>
          <h1>Conversations</h1>
          <p>Review customer messages and persisted automation state.</p>
        </div>
      </div>
      <div className="content-grid conversation-grid">
        <section className="panel conversation-list">
          <div className="eyebrow">RECENT THREADS</div>
          {conversations.isLoading && <div className="empty-row">Loading conversations…</div>}
          {conversations.isError && (
            <div className="alert error">
              {conversations.error instanceof Error ? conversations.error.message : 'Unable to load conversations.'}
            </div>
          )}
          {(conversations.data ?? []).map((conversation) => (
            <button
              className={`conversation-entry ${selectedId === conversation._id ? 'selected' : ''}`}
              key={conversation._id}
              onClick={() => setSelectedId(conversation._id)}
            >
              <strong>{display(conversation.customerId)}</strong>
              <span>
                {String(conversation.status)} · {String(conversation.currentStep)}
              </span>
              <small>{formatDate(conversation.lastMessageAt)}</small>
            </button>
          ))}
          {!conversations.isLoading && !conversations.isError && conversations.data?.length === 0 && (
            <div className="empty-row">No conversations yet.</div>
          )}
        </section>
        <section className="panel message-thread">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">MESSAGE HISTORY</div>
              <h2>{selected ? display(selected.customerId) : 'Select a thread'}</h2>
            </div>
            {selected && selected.status !== 'CLOSED' && (
              <button className="text-button" onClick={() => closeConversation.mutate()}>
                Close conversation
              </button>
            )}
          </div>
          {!selectedId && <div className="empty-row">Select a conversation to view its messages.</div>}
          {selectedId && messages.isLoading && <div className="empty-row">Loading message history…</div>}
          {messages.isError && (
            <div className="alert error">
              {messages.error instanceof Error ? messages.error.message : 'Unable to load message history.'}
            </div>
          )}
          {(messages.data ?? []).map((message) => (
            <article
              className={`message-bubble ${message.direction === 'OUTBOUND' ? 'outbound' : ''}`}
              key={message._id}
            >
              <div>{messageText(message.content)}</div>
              <small>
                {String(message.direction)} · {String(message.status)} · {formatDate(message.timestamp)}
              </small>
            </article>
          ))}
          {selected && selected.status !== 'CLOSED' && (
            <section className="message-composer">
              {serviceWindowOpen ? (
                <form onSubmit={submitReply}>
                  <label>
                    Reply to customer
                    <textarea
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      maxLength={4096}
                      placeholder="Write a WhatsApp reply…"
                      required
                    />
                  </label>
                  {sendReply.isError && (
                    <div className="alert error">
                      {sendReply.error instanceof Error ? sendReply.error.message : 'Message was not sent.'}
                    </div>
                  )}
                  <div className="composer-footer">
                    <span className="small muted">
                      Free-form replies are allowed only within the 24-hour customer service window.
                    </span>
                    <button className="primary-button" disabled={sendReply.isPending || !reply.trim()}>
                      {sendReply.isPending ? 'Sending…' : 'Send reply'} <span>→</span>
                    </button>
                  </div>
                </form>
              ) : (
                <form
                  className="template-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    sendTemplate.mutate();
                  }}
                >
                  <div className="alert error">
                    The 24-hour service window is closed. An approved template and recorded customer opt-in are
                    required.
                  </div>
                  <label>
                    Approved template
                    <select
                      required
                      value={templateId}
                      onChange={(event) => setTemplateId(event.target.value)}
                      disabled={approvedTemplates.isLoading}
                    >
                      <option value="">Select a template</option>
                      {(approvedTemplates.data ?? []).map((template) => (
                        <option key={template._id} value={template._id}>
                          {String(template.name)} · {String(template.languageCode)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Template components JSON
                    <textarea
                      value={templateComponents}
                      onChange={(event) => setTemplateComponents(event.target.value)}
                      placeholder="[]"
                      aria-describedby="template-components-help"
                    />
                  </label>
                  <span id="template-components-help" className="small muted">
                    Enter the approved template’s required components and parameters as a JSON array.
                  </span>
                  {approvedTemplates.isError && (
                    <div className="alert error">
                      {approvedTemplates.error instanceof Error
                        ? approvedTemplates.error.message
                        : 'Unable to load approved templates.'}
                    </div>
                  )}
                  {sendTemplate.isError && (
                    <div className="alert error">
                      {sendTemplate.error instanceof Error ? sendTemplate.error.message : 'Template was not sent.'}
                    </div>
                  )}
                  <div className="composer-footer">
                    <span className="small muted">Meta delivery status appears in the conversation history.</span>
                    <button
                      className="primary-button"
                      disabled={sendTemplate.isPending || !templateId || !approvedTemplates.data?.length}
                    >
                      {sendTemplate.isPending ? 'Sending…' : 'Send template'} <span>→</span>
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}
        </section>
      </div>
    </div>
  );
}

function display(value: unknown): string {
  if (!value || typeof value !== 'object') return '—';
  const record = value as Record<string, unknown>;
  return String(record.profileName ?? record.name ?? record.phoneNumber ?? record.whatsappId ?? record.email ?? '—');
}
function displayMany(value: unknown): string {
  return Array.isArray(value) ? value.map(display).join(', ') || '—' : '—';
}
function getId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && '_id' in value) return String((value as { _id: unknown })._id);
  return '';
}
function formatDate(value: unknown): string {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
function messageText(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '');
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (record.interactive && typeof record.interactive === 'object') {
    const reply = record.interactive as Record<string, unknown>;
    return String(reply.title ?? reply.id ?? 'Interactive response');
  }
  return JSON.stringify(record);
}
