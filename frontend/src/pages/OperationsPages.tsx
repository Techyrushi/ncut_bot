import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
  const [form, setForm] = useState({ name: '', metaTemplateId: '', languageCode: 'en_US', category: 'UTILITY' });
  const [defaultSendComponents, setDefaultSendComponents] = useState('[]');
  const [editingTemplate, setEditingTemplate] = useState<BasicRecord | null>(null);
  const [editingDefaults, setEditingDefaults] = useState('[]');
  const [notice, setNotice] = useState('');
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: async () => (await api.get<ApiResponse<Array<BasicRecord>>>('/templates')).data.data,
  });
  const create = useMutation({
    mutationFn: async (components: Array<Record<string, unknown>>) =>
      api.post('/templates', { ...form, components: [], defaultSendComponents: components }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['templates'] }),
        client.invalidateQueries({ queryKey: ['approved-message-templates'] }),
      ]);
      setForm({ name: '', metaTemplateId: '', languageCode: 'en_US', category: 'UTILITY' });
      setDefaultSendComponents('[]');
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
  const saveDefaults = useMutation({
    mutationFn: async () => {
      if (!editingTemplate) throw new Error('Select a template to edit.');
      let components: unknown;
      try {
        components = JSON.parse(editingDefaults);
      } catch {
        throw new Error('Default send components must be valid JSON.');
      }
      if (
        !Array.isArray(components) ||
        components.length > 20 ||
        components.some((component) => !isRecord(component))
      ) {
        throw new Error('Default send components must be an array of up to 20 component objects.');
      }
      return api.patch(`/templates/${editingTemplate._id}/default-send-components`, {
        defaultSendComponents: components,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['templates'] }),
        client.invalidateQueries({ queryKey: ['approved-message-templates'] }),
      ]);
      setEditingTemplate(null);
      setNotice('Default send values saved. The approved Meta template itself is unchanged.');
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Unable to save template defaults.'),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const components: unknown = JSON.parse(defaultSendComponents);
      if (!Array.isArray(components) || components.some((component) => !component || typeof component !== 'object' || Array.isArray(component))) {
        throw new Error('Default send components must be a JSON array of component objects.');
      }
      create.mutate(components as Array<Record<string, unknown>>);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Default send components must be valid JSON.');
    }
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
              Meta template ID
              <input
                required
                inputMode="numeric"
                pattern="[0-9]{8,30}"
                value={form.metaTemplateId}
                onChange={(e) => setForm({ ...form, metaTemplateId: e.target.value })}
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
          <label>
            Default send components JSON
            <textarea rows={4} value={defaultSendComponents} onChange={(e) => setDefaultSendComponents(e.target.value)} />
            <span className="form-hint">For image-header templates, include a public image URL parameter. Campaign-specific JSON can override these defaults.</span>
          </label>
          <button className="primary-button" disabled={create.isPending}>
            Add template <span>→</span>
          </button>
        </form>
      )}
      {user?.role === 'ADMIN' && editingTemplate && (
        <form
          className="panel template-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveDefaults.mutate();
          }}
        >
          <div className="eyebrow">EDIT DEFAULT SEND VALUES</div>
          <h2>{String(editingTemplate.name)} · {String(editingTemplate.languageCode)}</h2>
          <label>
            Default values for this approved template
            <textarea
              rows={5}
              value={editingDefaults}
              onChange={(event) => setEditingDefaults(event.target.value)}
              aria-describedby="default-send-values-help"
            />
            <span id="default-send-values-help" className="form-hint">
              These values prefill sends when no per-message values are provided. This does not edit Meta’s approved template.
            </span>
          </label>
          <div className="form-actions">
            <button type="button" className="secondary-button" onClick={() => setEditingTemplate(null)}>
              Cancel
            </button>
            <button className="primary-button" disabled={saveDefaults.isPending}>
              {saveDefaults.isPending ? 'Saving…' : 'Save defaults'} <span>→</span>
            </button>
          </div>
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
                <th>META TEMPLATE ID</th>
                <th>LANGUAGE</th>
                <th>CATEGORY</th>
                <th>META STATUS</th>
                <th>ADMIN ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {(templates.data ?? []).map((template) => (
                <tr key={template._id}>
                  <td>
                    <strong>{String(template.name)}</strong>
                  </td>
                  <td>{String(template.metaTemplateId ?? '—')}</td>
                  <td>{String(template.languageCode)}</td>
                  <td>{String(template.category)}</td>
                  <td>
                    <span className={`status-chip ${template.directSend || template.metaStatus === 'APPROVED' ? 'on' : 'off'}`}>
                      {template.directSend ? 'DIRECT SEND' : String(template.metaStatus)}
                    </span>
                  </td>
                  <td>
                    {user?.role === 'ADMIN' ? (
                      <div className="template-admin-actions">
                        {!template.directSend && (
                          <select
                            aria-label={`Status for ${String(template.name)}`}
                            value={String(template.metaStatus)}
                            onChange={(e) => update.mutate({ id: template._id, metaStatus: e.target.value })}
                          >
                            <option>PENDING</option>
                            <option>APPROVED</option>
                            <option>REJECTED</option>
                            <option>PAUSED</option>
                          </select>
                        )}
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setEditingTemplate(template);
                            setEditingDefaults(JSON.stringify(template.defaultSendComponents ?? [], null, 2));
                          }}
                        >
                          Edit defaults
                        </button>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
              {templates.data?.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-row">
                    No template records registered.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="small muted pad-inline">
          Register the exact name, language, and Meta ID from WhatsApp Manager. Only mark a template approved after Meta approves it.
        </p>
      </section>
    </div>
  );
}

export function LeadsPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [assigneeFilter, setAssigneeFilter] = useState('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [assignmentLead, setAssignmentLead] = useState<BasicRecord | null>(null);
  const [assignmentUserId, setAssignmentUserId] = useState('');
  const [showAddSalesRep, setShowAddSalesRep] = useState(false);
  const [salesRepForm, setSalesRepForm] = useState({ name: '', email: '', password: '' });
  const pageSize = 10;
  const leads = useQuery({
    queryKey: ['leads', deferredSearch, statusFilter, assigneeFilter, startDate, endDate, page],
    queryFn: async () => {
      const params: Record<string, string | number> = { page, limit: pageSize };
      if (deferredSearch) params.search = deferredSearch;
      if (statusFilter !== 'ALL') params.status = statusFilter;
      if (assigneeFilter !== 'ALL') params.assignedSalesPerson = assigneeFilter;
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      return (await api.get<ApiResponse<PageResult<BasicRecord>>>('/leads', { params })).data.data;
    },
    refetchOnWindowFocus: true,
  });
  const team = useQuery({
    queryKey: ['team'],
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
      setAssignmentLead(null);
    },
  });
  const openLeadHistory = useMutation({
    mutationFn: async ({ leadId, conversationId }: { leadId: string; conversationId: string }) => {
      await api.patch(`/leads/${leadId}/read`);
      return conversationId;
    },
    onSuccess: async (conversationId) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['leads'] }),
        client.invalidateQueries({ queryKey: ['unread-leads-count'] }),
      ]);
      navigate(`/conversations?conversation=${encodeURIComponent(conversationId)}`);
    },
  });
  const addSalesRepAndAssign = useMutation({
    mutationFn: async () => {
      if (!assignmentLead) throw new Error('Choose a lead before adding a representative.');
      const { data } = await api.post<ApiResponse<{ id: string }>>('/team', salesRepForm);
      try {
        await api.patch(`/leads/${assignmentLead._id}/assign`, { userId: data.data.id });
      } catch (error) {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['team'] }),
          client.invalidateQueries({ queryKey: ['leads'] }),
        ]);
        const detail = error instanceof Error ? error.message : 'assignment confirmation failed';
        throw new Error(`The sales account was created, but assignment could not be confirmed: ${detail}. Close this dialog and retry from the updated team list.`);
      }
      return data.data;
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['leads'] }),
        client.invalidateQueries({ queryKey: ['team'] }),
      ]);
      setAssignmentLead(null);
      setShowAddSalesRep(false);
      setSalesRepForm({ name: '', email: '', password: '' });
    },
  });
  const exportLeads = useMutation({
    mutationFn: async () => {
      const params: Record<string, string> = {};
      if (deferredSearch) params.search = deferredSearch;
      if (statusFilter !== 'ALL') params.status = statusFilter;
      if (assigneeFilter !== 'ALL') params.assignedSalesPerson = assigneeFilter;
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      return api.get('/leads/export.csv', { params, responseType: 'blob' });
    },
    onSuccess: (response) => {
      const url = URL.createObjectURL(response.data as Blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ncut-leads-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  const total = leads.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const filtersActive =
    Boolean(search.trim() || startDate || endDate) || statusFilter !== 'ALL' || assigneeFilter !== 'ALL';
  const teamMembers = team.data ?? [];
  function clearFilters(): void {
    setSearch('');
    setStatusFilter('ALL');
    setAssigneeFilter('ALL');
    setStartDate('');
    setEndDate('');
    setPage(1);
  }
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SALES / PIPELINE</div>
          <h1>Leads</h1>
          <p>Review customer requirements, assign ownership, and track each sales outcome.</p>
        </div>
      </div>
      <section className="panel table-panel">
        <div className="panel-heading leads-table-heading">
          <div>
            <div className="eyebrow">FOLLOW-UP QUEUE</div>
            <h2>{total} {total === 1 ? 'lead' : 'leads'}</h2>
            <p>Use filters to focus the queue. Export downloads all matching leads.</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => exportLeads.mutate()}
            disabled={exportLeads.isPending || total === 0}
          >
            {exportLeads.isPending ? 'Preparing export…' : 'Export filtered CSV'}
            <span aria-hidden="true">↓</span>
          </button>
        </div>
        {leads.isError && (
          <div className="alert error">
            {leads.error instanceof Error ? leads.error.message : 'Unable to load leads.'}
          </div>
        )}
        {team.isError && (
          <div className="alert error">
            {team.error instanceof Error ? team.error.message : 'Unable to load sales assignments.'}
          </div>
        )}
        {update.isError && (
          <div className="alert error">{update.error instanceof Error ? update.error.message : 'Unable to update lead status.'}</div>
        )}
        {assign.isError && (
          <div className="alert error">{assign.error instanceof Error ? assign.error.message : 'Unable to update lead assignment.'}</div>
        )}
        {exportLeads.isError && (
          <div className="alert error">
            {exportLeads.error instanceof Error ? exportLeads.error.message : 'Unable to export matching leads.'}
          </div>
        )}
        {openLeadHistory.isError && (
          <div className="alert error" role="alert">
            {openLeadHistory.error instanceof Error ? openLeadHistory.error.message : 'Unable to open lead chat history.'}
          </div>
        )}
        <div className="table-toolbar leads-toolbar">
          <label className="table-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search customer, number, product, requirement, feedback, or lead ID…"
              aria-label="Search leads"
            />
          </label>
          <label className="filter-control">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="ALL">All statuses</option>
              <option value="NEW">New</option>
              <option value="CONTACTED">Contacted</option>
              <option value="QUALIFIED">Qualified</option>
              <option value="WON">Won</option>
              <option value="LOST">Lost</option>
            </select>
          </label>
          <label className="filter-control">
            <span>Assignee</span>
            <select
              value={assigneeFilter}
              onChange={(event) => {
                setAssigneeFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="ALL">All assignees</option>
              <option value="assigned">Assigned</option>
              <option value="unassigned">Unassigned</option>
              {teamMembers.map((person) => (
                <option key={person._id} value={person._id}>
                  {String(person.name)}{person.isActive === true ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-control">
            <span>Created from</span>
            <input
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(event) => {
                setStartDate(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="filter-control">
            <span>Created to</span>
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => {
                setEndDate(event.target.value);
                setPage(1);
              }}
            />
          </label>
          {filtersActive && (
            <button type="button" className="table-reset-button" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
        {leads.isLoading && <div className="table-loading">Loading leads…</div>}
        <div className="table-scroll">
          <table className="admin-data-table leads-data-table">
            <thead>
              <tr>
                <th>CUSTOMER</th>
                <th>CUSTOMER REQUEST</th>
                <th>INTERESTED PRODUCTS</th>
                <th>ASSIGNEE</th>
                <th>STATUS</th>
                <th>FEEDBACK</th>
                <th>LEAD RECEIPT</th>
                <th>CREATED</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {(leads.data?.items ?? []).map((lead) => (
                <tr key={lead._id}>
                  <td>
                    <div className="lead-customer-cell">
                      <strong>
                        {display(lead.customerId)}
                        {lead.isUnreadLead === true && (
                          <span className="lead-new-indicator" title="New lead activity" aria-label="New lead activity" />
                        )}
                      </strong>
                      <span>{customerPhone(lead.customerId) || 'WhatsApp number unavailable'}</span>
                    </div>
                  </td>
                  <td className="lead-requirement-cell">
                    {typeof lead.requirement === 'string' && lead.requirement.trim() ? lead.requirement : 'Not provided'}
                  </td>
                  <td className="lead-products-cell">{displayMany(lead.selectedProducts)}</td>
                  <td>
                    {user?.role === 'ADMIN' ? (
                      <button
                        type="button"
                        className="secondary-button lead-assign-button"
                        title="Assign this lead to an active sales representative"
                        onClick={() => {
                          setAssignmentLead(lead);
                          setAssignmentUserId(getId(lead.assignedSalesPerson));
                          setShowAddSalesRep(false);
                          assign.reset();
                          addSalesRepAndAssign.reset();
                        }}
                      >
                        {getId(lead.assignedSalesPerson) ? display(lead.assignedSalesPerson) : 'Assign rep'}
                      </button>
                    ) : (
                      <span className="lead-assignee">{display(lead.assignedSalesPerson)}</span>
                    )}
                  </td>
                  <td>
                    <select
                      aria-label={`Update status for ${display(lead.customerId)}`}
                      title="Change lead status"
                      value={String(lead.status)}
                      onChange={(e) => update.mutate({ id: lead._id, status: e.target.value })}
                      disabled={update.isPending && update.variables?.id === lead._id}
                    >
                      <option value="NEW">New</option>
                      <option value="CONTACTED">Contacted</option>
                      <option value="QUALIFIED">Qualified</option>
                      <option value="WON">Won</option>
                      <option value="LOST">Lost</option>
                    </select>
                  </td>
                  <td>
                    <span className="lead-feedback-cell">
                      {lead.feedback === 'HAPPY' ? 'Happy 😄' : lead.feedback === 'NEUTRAL' ? 'Neutral 😐' : lead.feedback === 'UNHAPPY' ? 'Unhappy 😞' : 'Not provided'}
                    </span>
                  </td>
                  <td>
                    <span className={`status-chip ${['SENT', 'ACCEPTED'].includes(String(lead.notificationStatus)) ? 'on' : 'off'}`}>
                      {String(lead.notificationStatus ?? 'PENDING')}
                    </span>
                    {typeof lead.notificationDeliveryStatus === 'string' && (
                      <small className="small muted">Delivery: {String(lead.notificationDeliveryStatus)}</small>
                    )}
                  </td>
                  <td>{formatDate(lead.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="secondary-button lead-history-button"
                      title="Open the customer’s WhatsApp thread, including messages from previous visits"
                      disabled={!getId(lead.latestConversationId) || openLeadHistory.isPending}
                      onClick={() =>
                        openLeadHistory.mutate({
                          leadId: lead._id,
                          conversationId: getId(lead.latestConversationId),
                        })
                      }
                    >
                      View chat history
                      <span className="lead-history-count">{Number(lead.chatHistoryCount ?? 0)} visits</span>
                    </button>
                  </td>
                </tr>
              ))}
              {leads.data?.items.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty-row">
                    {filtersActive ? 'No leads match these filters. Try broadening your search.' : 'No leads yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="table-pagination">
          <span>
            {total
              ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total} leads`
              : 'No matching leads'}
          </span>
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={page === 1 || leads.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={page >= pageCount || leads.isFetching}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>
      {assignmentLead && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setAssignmentLead(null);
        }}>
          <section className="modal-card assignment-modal" role="dialog" aria-modal="true" aria-labelledby="assign-lead-title">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">LEAD OWNERSHIP</div>
                <h2 id="assign-lead-title">Assign sales representative</h2>
                <p>{display(assignmentLead.customerId)} · {customerPhone(assignmentLead.customerId) || 'WhatsApp number unavailable'}</p>
              </div>
              <button type="button" className="icon-button" aria-label="Close assignment dialog" onClick={() => setAssignmentLead(null)}>×</button>
            </div>
            {!showAddSalesRep ? (
              <>
                <label className="field-label" htmlFor="lead-assignee-select">Sales team member</label>
                <select
                  id="lead-assignee-select"
                  value={assignmentUserId}
                  onChange={(event) => setAssignmentUserId(event.target.value)}
                  disabled={team.isLoading}
                >
                  <option value="">Unassigned</option>
                  {teamMembers
                    .filter((person) => person.isActive === true || person._id === getId(assignmentLead.assignedSalesPerson))
                    .map((person) => (
                      <option key={person._id} value={person._id}>
                        {String(person.name)}{person.isActive === true ? '' : ' (inactive)'}
                      </option>
                    ))}
                </select>
                {team.isLoading && <p className="form-hint">Loading sales team…</p>}
                {!team.isLoading && teamMembers.filter((person) => person.isActive === true).length === 0 && (
                  <p className="form-hint">No active sales representatives yet. Add a team member to assign this lead.</p>
                )}
                {assign.error && <p className="form-error" role="alert">{assign.error.message}</p>}
                <div className="modal-actions">
                  <button type="button" className="secondary-button" onClick={() => setShowAddSalesRep(true)}>Add sales rep</button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={assign.isPending || team.isLoading || assignmentUserId === getId(assignmentLead.assignedSalesPerson)}
                    onClick={() => assign.mutate({ id: assignmentLead._id, userId: assignmentUserId })}
                  >
                    {assign.isPending ? 'Saving…' : 'Save assignment'}
                  </button>
                </div>
              </>
            ) : (
              <form
                className="assignment-create-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  addSalesRepAndAssign.mutate();
                }}
              >
                <p className="form-hint">Create a sales account and assign this lead to them.</p>
                <label className="field-label">Full name<input required maxLength={120} value={salesRepForm.name} onChange={(event) => setSalesRepForm({ ...salesRepForm, name: event.target.value })} /></label>
                <label className="field-label">Email<input required type="email" value={salesRepForm.email} onChange={(event) => setSalesRepForm({ ...salesRepForm, email: event.target.value })} /></label>
                <label className="field-label">Temporary password<input required type="password" minLength={12} maxLength={200} autoComplete="new-password" value={salesRepForm.password} onChange={(event) => setSalesRepForm({ ...salesRepForm, password: event.target.value })} /><span className="form-hint">At least 12 characters. Share it securely with the new team member.</span></label>
                {addSalesRepAndAssign.error && <p className="form-error" role="alert">{addSalesRepAndAssign.error.message}</p>}
                <div className="modal-actions">
                  <button type="button" className="secondary-button" onClick={() => setShowAddSalesRep(false)}>Back</button>
                  <button type="submit" className="primary-button" disabled={addSalesRepAndAssign.isPending}>
                    {addSalesRepAndAssign.isPending ? 'Creating…' : 'Create and assign'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function LeadNotificationPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const lead = useQuery({
    queryKey: ['lead', id],
    enabled: user?.role === 'ADMIN' && Boolean(id),
    queryFn: async () => (await api.get<ApiResponse<BasicRecord>>(`/leads/${id}`)).data.data,
  });

  if (user?.role !== 'ADMIN') return <Navigate to="/leads" replace />;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SALES / LEAD NOTIFICATION</div>
          <h1>New sales lead</h1>
          <p>Review the customer request and follow-up details.</p>
        </div>
        <Link to="/leads" className="secondary-button">All leads</Link>
      </div>
      {lead.isLoading && <div className="empty-row">Loading lead…</div>}
      {lead.isError && (
        <div className="alert error" role="alert">
          {lead.error instanceof Error ? lead.error.message : 'Unable to load this lead.'}
        </div>
      )}
      {lead.data && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">CUSTOMER</div>
              <h2>{display(lead.data.customerId)}</h2>
              <span className="contact-subtitle">{customerPhone(lead.data.customerId) || 'WhatsApp number unavailable'}</span>
            </div>
            <span className="status-chip on">{String(lead.data.status)}</span>
          </div>
          <dl className="detail-grid">
            <div>
              <dt>Customer request</dt>
              <dd>{String(lead.data.requirement || 'Not provided')}</dd>
            </div>
            <div>
              <dt>Interested products</dt>
              <dd>{displayMany(lead.data.selectedProducts)}</dd>
            </div>
            <div>
              <dt>Assigned sales representative</dt>
              <dd>{display(lead.data.assignedSalesPerson)}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDate(lead.data.createdAt)}</dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}

export function ConversationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const selectedId = searchParams.get('conversation') ?? '';
  const [reply, setReply] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templateParameters, setTemplateParameters] = useState<Record<string, string>>({});
  const [showTemplateSender, setShowTemplateSender] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now());
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [attachment, setAttachment] = useState<File>();
  const [attachmentPreview, setAttachmentPreview] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
  const [interactiveMode, setInteractiveMode] = useState(false);
  const [interactiveBody, setInteractiveBody] = useState('');
  const [interactiveButtonTitles, setInteractiveButtonTitles] = useState('');
  const [serviceWindowRejected, setServiceWindowRejected] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatForm, setNewChatForm] = useState({
    phoneNumber: '',
    name: '',
    consentSource: 'Meta Business',
    consentConfirmed: false,
  });
  const lastReadRequest = useRef('');
  const client = useQueryClient();
  const messageEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!attachmentPreview.startsWith('blob:')) return;
    return () => URL.revokeObjectURL(attachmentPreview);
  }, [attachmentPreview]);
  useEffect(() => {
    setReply('');
    setAttachment(undefined);
    setAttachmentPreview('');
    setAttachmentError('');
    setShowEmojiPicker(false);
    setInteractiveMode(false);
    setInteractiveBody('');
    setInteractiveButtonTitles('');
    setShowTemplateSender(false);
  }, [selectedId]);

  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: async () =>
      (await api.get<ApiResponse<PageResult<BasicRecord>>>('/conversations?limit=100')).data.data.items,
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });
  const messages = useQuery({
    queryKey: ['conversation-messages', selectedId],
    enabled: Boolean(selectedId),
    queryFn: async () =>
      (await api.get<ApiResponse<Array<BasicRecord>>>(`/conversations/${selectedId}/messages`)).data.data,
    refetchInterval: selectedId ? 3000 : false,
    refetchOnWindowFocus: true,
  });
  const approvedTemplates = useQuery({
    queryKey: ['approved-message-templates'],
    enabled: Boolean(selectedId),
    queryFn: async () =>
      (await api.get<ApiResponse<BasicRecord[]>>('/templates')).data.data.filter(
        (template) =>
          template.metaStatus === 'APPROVED' ||
          template.metaStatus === 'PENDING' ||
          template.directSend === true,
      ),
  });
  const startConversation = useMutation({
    mutationFn: async () =>
      (await api.post<ApiResponse<{ conversationId: string }>>('/conversations/start', newChatForm)).data.data,
    onSuccess: async ({ conversationId }) => {
      setShowNewChat(false);
      setNewChatForm({ phoneNumber: '', name: '', consentSource: 'Meta Business', consentConfirmed: false });
      await client.invalidateQueries({ queryKey: ['conversations'] });
      setSearchParams({ conversation: conversationId });
    },
  });
  const selected = conversations.data?.find((conversation) => conversation._id === selectedId);
  const lastInboundMessageAt = selected?.lastInboundMessageAt
    ? new Date(String(selected.lastInboundMessageAt)).getTime()
    : 0;
  const serviceWindowExpiresAt = lastInboundMessageAt + 24 * 60 * 60 * 1000;
  const serviceWindowRemaining = Math.max(0, serviceWindowExpiresAt - clockNow);
  const serviceWindowOpen =
    !serviceWindowRejected &&
    lastInboundMessageAt > 0 &&
    lastInboundMessageAt <= clockNow &&
    clockNow < serviceWindowExpiresAt;
  const selectedTemplate = approvedTemplates.data?.find((template) => template._id === templateId);
  const selectedTemplateCanSend =
    selectedTemplate?.metaStatus === 'APPROVED' || selectedTemplate?.directSend === true;
  const templateFields = getTemplateFields(selectedTemplate);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setServiceWindowRejected(false);
    setTemplateId('');
    setTemplateParameters({});
  }, [selectedId, selected?.lastInboundMessageAt]);
  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.data, selectedId]);
  const markRead = useMutation({
    mutationFn: async () => api.post(`/conversations/${selectedId}/read`),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['conversations'] }),
        client.invalidateQueries({ queryKey: ['conversation-messages', selectedId] }),
      ]);
    },
  });
  useEffect(() => {
    if (!selectedId || Number(selected?.unreadCount ?? 0) === 0) {
      lastReadRequest.current = '';
      return;
    }
    if (!markRead.isPending && lastReadRequest.current !== selectedId) {
      lastReadRequest.current = selectedId;
      markRead.mutate();
    }
  }, [selectedId, selected?.unreadCount, markRead.isPending]);
  const closeConversation = useMutation({
    mutationFn: async () => api.patch(`/conversations/${selectedId}/status`, { status: 'CLOSED' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const resumeAutomation = useMutation({
    mutationFn: async () => api.post(`/conversations/${selectedId}/resume-automation`),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['conversations'] }),
        client.invalidateQueries({ queryKey: ['conversation-messages', selectedId] }),
      ]);
    },
  });
  const sendReply = useMutation({
    mutationFn: async () => {
      const customerId = getId(selected?.customerId);
      if (!customerId) throw new Error('The selected conversation has no customer record.');
      if (attachment) {
        const upload = await api.post<ApiResponse<{ imageUrl: string }>>('/products/image-upload', attachment, {
          headers: { 'Content-Type': attachment.type },
        });
        return api.post('/whatsapp/send-image', {
          customerId,
          imageUrl: upload.data.data.imageUrl,
          caption: reply.trim(),
        });
      }
      return api.post('/whatsapp/send-message', { customerId, message: reply.trim() });
    },
    onMutate: async () => {
      await client.cancelQueries({ queryKey: ['conversation-messages', selectedId] });
      const previous = client.getQueryData<BasicRecord[]>(['conversation-messages', selectedId]);
      const optimistic: BasicRecord = {
        _id: `optimistic-${Date.now()}`,
        direction: 'OUTBOUND',
        messageType: attachment ? 'IMAGE' : 'TEXT',
        content: attachment
          ? { imageUrl: attachmentPreview, caption: reply.trim() }
          : { text: reply.trim() },
        status: 'QUEUED',
        timestamp: new Date().toISOString(),
      };
      client.setQueryData<BasicRecord[]>(['conversation-messages', selectedId], (current) => [
        ...(current ?? []),
        optimistic,
      ]);
      return { previous };
    },
    onSuccess: async () => {
      setReply('');
      setAttachment(undefined);
      setAttachmentPreview('');
      setAttachmentError('');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['conversation-messages', selectedId] }),
        client.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
    },
    onError: (error, _variables, context) => {
      if (context?.previous) client.setQueryData(['conversation-messages', selectedId], context.previous);
      if (isServiceWindowExpired(error)) {
        setServiceWindowRejected(true);
        void client.invalidateQueries({ queryKey: ['conversations'] });
      }
    },
  });
  const sendTemplate = useMutation({
    mutationFn: async () => {
      const customerId = getId(selected?.customerId);
      if (!customerId) throw new Error('The selected conversation has no customer record.');
      const components = buildTemplateComponents(selectedTemplate, templateFields, templateParameters);
      return api.post('/whatsapp/send-template', { customerId, templateId, components });
    },
    onSuccess: async () => {
      setTemplateId('');
      setTemplateParameters({});
      setShowTemplateSender(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['conversation-messages', selectedId] }),
        client.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
    },
  });
  const sendInteractive = useMutation({
    mutationFn: async () => {
      const customerId = getId(selected?.customerId);
      if (!customerId) throw new Error('The selected conversation has no customer record.');
      const buttons = interactiveButtonTitles
        .split('\n')
        .map((title, index) => ({ id: `reply_${index + 1}`, title: title.trim() }))
        .filter((button) => button.title);
      return api.post('/whatsapp/send-interactive', { customerId, body: interactiveBody.trim(), buttons });
    },
    onSuccess: async () => {
      setInteractiveMode(false);
      setInteractiveBody('');
      setInteractiveButtonTitles('');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['conversation-messages', selectedId] }),
        client.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
    },
    onError: (error) => {
      if (isServiceWindowExpired(error)) {
        setServiceWindowRejected(true);
        void client.invalidateQueries({ queryKey: ['conversations'] });
      }
    },
  });
  function closeNewChat(): void {
    setShowNewChat(false);
    setNewChatForm({ phoneNumber: '', name: '', consentSource: 'Meta Business', consentConfirmed: false });
    startConversation.reset();
  }
  function submitReply(event: FormEvent): void {
    event.preventDefault();
    if (interactiveMode) return;
    if (reply.trim() || attachment) sendReply.mutate();
  }
  function chooseAttachment(file?: File): void {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setAttachmentError('Only JPEG, PNG, and WebP image attachments are supported.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAttachmentError('Image attachments must be 5 MB or smaller.');
      return;
    }
    setAttachmentError('');
    setAttachment(file);
    setAttachmentPreview(URL.createObjectURL(file));
  }
  function insertEmoji(emoji: string): void {
    setReply((current) => `${current}${emoji}`);
    setShowEmojiPicker(false);
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MESSAGING / INBOX</div>
          <h1>Conversations</h1>
          <p>Reply to customers and follow WhatsApp delivery and read receipts.</p>
        </div>
        <div className="conversation-page-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              startConversation.reset();
              setShowNewChat(true);
            }}
          >
            New chat
          </button>
          {user?.role === 'ADMIN' && (
            <Link to="/bulk-campaigns" className="primary-button">
              Bulk message
            </Link>
          )}
        </div>
      </div>
      <div className={`content-grid conversation-grid ${selectedId ? 'mobile-has-selection' : ''}`}>
        <section className="panel conversation-list">
          <div className="conversation-list-heading">
            <div className="eyebrow">RECENT THREADS</div>
            <span>{conversations.data?.length ?? 0}</span>
          </div>
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
              onClick={() => setSearchParams({ conversation: conversation._id })}
            >
              <span className="conversation-avatar">{display(conversation.customerId).slice(0, 1).toUpperCase()}</span>
              <span className="conversation-entry-copy">
                <strong>{display(conversation.customerId)}</strong>
                <span>{conversationPreview(conversation)}</span>
                <small>{formatRelativeDate(conversation.lastMessageAt)}</small>
              </span>
              {Number(conversation.unreadCount ?? 0) > 0 && (
                <span className="conversation-unread">{String(conversation.unreadCount)}</span>
              )}
            </button>
          ))}
          {!conversations.isLoading && !conversations.isError && conversations.data?.length === 0 && (
            <div className="empty-row">No conversations yet.</div>
          )}
        </section>
        <section className="panel message-thread">
          <div className="panel-heading">
            <div>
              <button
                type="button"
                className="conversation-back"
                onClick={() => setSearchParams({})}
                aria-label="Back to conversations"
              >
                ←
              </button>
              <div>
                <div className="eyebrow">MESSAGE HISTORY</div>
                <h2>{selected ? display(selected.customerId) : 'Select a conversation'}</h2>
                {selected && (
                  <span className="contact-subtitle">
                    {customerPhone(selected.customerId)} · {customerActivity(selected.lastInboundMessageAt)}
                  </span>
                )}
              </div>
            </div>
            {selected && selected.status !== 'CLOSED' && (
              <div className="conversation-actions">
                {selected.status === 'HUMAN_HANDOVER' && (
                  <button
                    className="text-button"
                    onClick={() => resumeAutomation.mutate()}
                    disabled={resumeAutomation.isPending}
                  >
                    {resumeAutomation.isPending ? 'Resuming…' : 'Resume automation'}
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={() => closeConversation.mutate()}
                  disabled={closeConversation.isPending}
                >
                  Close conversation
                </button>
              </div>
            )}
          </div>
          {resumeAutomation.isError && (
            <div className="alert error">
              {resumeAutomation.error instanceof Error
                ? resumeAutomation.error.message
                : 'Unable to resume automation.'}
            </div>
          )}
          {!selectedId && <div className="empty-row">Select a conversation to view its messages.</div>}
          {selectedId && messages.isLoading && <div className="empty-row">Loading message history…</div>}
          {messages.isError && (
            <div className="alert error">
              {messages.error instanceof Error ? messages.error.message : 'Unable to load message history.'}
            </div>
          )}
          {markRead.isError && (
            <div className="alert error">
              {markRead.error instanceof Error ? markRead.error.message : 'Unable to mark messages as read.'}
              <button
                onClick={() => {
                  lastReadRequest.current = '';
                  markRead.mutate();
                }}
              >
                Try again
              </button>
            </div>
          )}
          {selectedId && (
            <div className="message-history" aria-live="polite">
              {selected?.status === 'HUMAN_HANDOVER' && (
                <div className="alert">
                  Sales handover is active. New customer messages stay in this inbox; automation remains paused until
                  you resume it.
                </div>
              )}
              {(messages.data ?? []).map((message) => {
                const outbound = message.direction === 'OUTBOUND';
                const imageUrl = messageImageUrl(message.content);
                const videoUrl = messageMediaUrl(message.content, 'video');
                const document = messageDocument(message.content);
                const buttons = messageButtons(message.content);
                return (
                  <article className={`message-bubble ${outbound ? 'outbound' : ''}`} key={message._id}>
                    {imageUrl && <img className="message-attachment" src={imageUrl} alt="Shared image" />}
                    {videoUrl && <video className="message-attachment" src={videoUrl} controls />}
                    {document && (
                      <a className="message-document-link" href={document.url} target="_blank" rel="noreferrer">
                        {document.filename || 'Open document'}
                      </a>
                    )}
                    <div>{messageText(message.content)}</div>
                    {buttons.length > 0 && (
                      <div className="message-reply-options" aria-label="WhatsApp reply options">
                        {buttons.map((button) => (
                          <span key={button.id}>{button.title}</span>
                        ))}
                      </div>
                    )}
                    <small>
                      {outbound ? 'You' : display(selected?.customerId)} · {formatDate(message.timestamp)}
                      {outbound && (
                        <span
                          className={`message-receipt ${String(message.status).toLowerCase()}`}
                          title={
                            message.status === 'SENT'
                              ? 'WhatsApp accepted the message. Delivery confirmation is pending.'
                              : undefined
                          }
                        >
                          {receiptLabel(message.status)}
                        </span>
                      )}
                    </small>
                  </article>
                );
              })}
              <div ref={messageEndRef} />
            </div>
          )}
          {selected && (
            <section className="message-composer">
              {serviceWindowOpen && (
                <form onSubmit={submitReply}>
                  <label className="interactive-toggle">
                    <input
                      className="interactive-toggle-checkbox"
                      type="checkbox"
                      checked={interactiveMode}
                      onChange={(event) => setInteractiveMode(event.target.checked)}
                    />
                    <span>Send interactive reply buttons</span>
                  </label>
                  {interactiveMode && (
                    <>
                      <label>
                        Interactive message
                        <textarea
                          value={interactiveBody}
                          onChange={(event) => setInteractiveBody(event.target.value)}
                          maxLength={1024}
                          placeholder="Message shown with reply buttons"
                          rows={2}
                        />
                      </label>
                      <label>
                        Button titles (one per line, up to 3; 20 characters each)
                        <textarea
                          value={interactiveButtonTitles}
                          onChange={(event) => setInteractiveButtonTitles(event.target.value)}
                          placeholder={'View products\nContact sales'}
                          rows={3}
                        />
                      </label>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={
                          sendInteractive.isPending ||
                          !interactiveBody.trim() ||
                          interactiveButtonTitles.split('\n').filter((title) => title.trim()).length < 1 ||
                          interactiveButtonTitles.split('\n').filter((title) => title.trim()).length > 3 ||
                          interactiveButtonTitles.split('\n').some((title) => title.trim().length > 20)
                        }
                        onClick={() => sendInteractive.mutate()}
                      >
                        {sendInteractive.isPending ? 'Sending…' : 'Send interactive message'} <span>→</span>
                      </button>
                      {sendInteractive.isError && !isServiceWindowExpired(sendInteractive.error) && (
                        <div className="alert error">
                          {sendInteractive.error instanceof Error
                            ? sendInteractive.error.message
                            : 'Interactive message was not sent.'}
                        </div>
                      )}
                    </>
                  )}
                  {!interactiveMode && (
                    <>
                      {attachmentPreview && (
                        <div className="attachment-preview">
                          <img src={attachmentPreview} alt="Attachment preview" />
                          <button
                            type="button"
                            className="text-button danger-text"
                            onClick={() => {
                              setAttachment(undefined);
                              setAttachmentPreview('');
                              setAttachmentError('');
                            }}
                          >
                            Remove image
                          </button>
                        </div>
                      )}
                      <div className="composer-input-row">
                        <div className="composer-tools">
                          <button
                            type="button"
                            className="composer-tool"
                            aria-label="Add emoji"
                            aria-expanded={showEmojiPicker}
                            onClick={() => setShowEmojiPicker((shown) => !shown)}
                          >
                            ☺
                          </button>
                          <label className="composer-tool attach-tool" aria-label="Attach image">
                            +
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              onChange={(event) => chooseAttachment(event.target.files?.[0])}
                            />
                          </label>
                        </div>
                        <textarea
                          aria-label="Message"
                          value={reply}
                          onChange={(event) => setReply(event.target.value)}
                          maxLength={attachment ? 1024 : 4096}
                          placeholder="Write a WhatsApp message…"
                          rows={1}
                        />
                        <button
                          className="primary-button"
                          disabled={sendReply.isPending || Boolean(attachmentError) || (!reply.trim() && !attachment)}
                        >
                          {sendReply.isPending ? 'Sending…' : 'Send'} <span>→</span>
                        </button>
                      </div>
                      {showEmojiPicker && (
                        <div className="emoji-picker" aria-label="Choose an emoji">
                          {['🙂', '😊', '👍', '❤️', '🎉', '🙏', '✨', '👋'].map((emoji) => (
                            <button key={emoji} type="button" onClick={() => insertEmoji(emoji)}>
                              {emoji}
                            </button>
                          ))}
                        </div>
                      )}
                      {sendReply.isError && (
                        <div className="alert error">
                          {sendReply.error instanceof Error ? sendReply.error.message : 'Message was not sent.'}
                        </div>
                      )}
                      {attachmentError && <div className="alert error">{attachmentError}</div>}
                      <div className="composer-footer">
                        <span className="small muted">
                          WhatsApp service window · {formatCountdown(serviceWindowRemaining)} remaining ·{' '}
                          {(attachment ? 1024 : 4096) - reply.length} characters left
                        </span>
                      </div>
                    </>
                  )}
                </form>
              )}
              {!serviceWindowOpen && (
                <div className="service-window-notice" role="status">
                  <span className="service-window-notice-icon" aria-hidden="true">
                    i
                  </span>
                  <div>
                    <strong>{lastInboundMessageAt ? 'Continue with a template' : 'Start with a template'}</strong>
                    <p>
                      {lastInboundMessageAt
                        ? 'The 24-hour reply window has ended. Send a template to continue; customer opt-in is required.'
                        : 'A template can start this chat; customer opt-in is required.'}
                    </p>
                  </div>
                </div>
              )}
              {serviceWindowOpen && (
                <button
                  type="button"
                  className="template-sender-toggle"
                  aria-expanded={showTemplateSender}
                  aria-controls="template-sender-form"
                  onClick={() => setShowTemplateSender((shown) => !shown)}
                >
                  <span>Send an approved template</span>
                  <span className="template-sender-toggle-hint">Optional</span>
                  <span className="template-sender-toggle-icon" aria-hidden="true">
                    {showTemplateSender ? '−' : '+'}
                  </span>
                </button>
              )}
              {(!serviceWindowOpen || showTemplateSender) && (
                <form
                  id="template-sender-form"
                  className="template-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    sendTemplate.mutate();
                  }}
                >
                  <label>
                    Approved template or Direct Send
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
                          {template.directSend ? ' · Direct Send' : ''}
                          {template.metaStatus === 'PENDING' && !template.directSend ? ' · Pending approval' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {templateFields.map((field) => (
                    <label key={field.id}>
                      {field.label}
                      <input
                        type={field.type === 'text' ? 'text' : 'url'}
                        required
                        value={templateParameters[field.id] ?? field.defaultValue}
                        placeholder={field.placeholder}
                        onChange={(event) =>
                          setTemplateParameters((current) => ({ ...current, [field.id]: event.target.value }))
                        }
                      />
                    </label>
                  ))}
                  {templateId && templateFields.length === 0 && (
                    <span className="small muted">This template does not require any parameters.</span>
                  )}
                  {selectedTemplate?.metaStatus === 'PENDING' && (
                    <span className="small muted" role="status">
                      This template is awaiting Meta approval and cannot be sent yet.
                    </span>
                  )}
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
                    <span className="small muted">Delivery status updates automatically.</span>
                    <button
                      className="primary-button"
                      disabled={
                        sendTemplate.isPending ||
                        !templateId ||
                        !selectedTemplateCanSend ||
                        !approvedTemplates.data?.length ||
                        templateFields.some((field) => !(templateParameters[field.id] ?? field.defaultValue).trim())
                      }
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
      {showNewChat && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !startConversation.isPending) closeNewChat();
          }}
        >
          <section className="modal-card new-chat-modal" role="dialog" aria-modal="true" aria-labelledby="new-chat-title">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">WHATSAPP / NEW CHAT</div>
                <h2 id="new-chat-title">Add a number</h2>
                <p>Add the contact after confirming their WhatsApp opt-in.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close new chat dialog"
                disabled={startConversation.isPending}
                onClick={closeNewChat}
              >
                ×
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                startConversation.mutate();
              }}
            >
              <label className="field-label">
                WhatsApp number
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  required
                  maxLength={40}
                  placeholder="+91 98765 43210"
                  value={newChatForm.phoneNumber}
                  onChange={(event) => setNewChatForm((current) => ({ ...current, phoneNumber: event.target.value }))}
                />
              </label>
              <label className="field-label">
                Customer name <span className="muted">(optional)</span>
                <input
                  maxLength={120}
                  value={newChatForm.name}
                  onChange={(event) => setNewChatForm((current) => ({ ...current, name: event.target.value }))}
                />
              </label>
              <label className="field-label">
                Verified opt-in source
                <input
                  required
                  maxLength={500}
                  readOnly
                  value={newChatForm.consentSource}
                />
                <span className="form-hint">
                  Use this source only when you have verified that the customer explicitly opted in through Meta
                  Business.
                </span>
              </label>
              <label className="new-chat-consent">
                <input
                  type="checkbox"
                  required
                  checked={newChatForm.consentConfirmed}
                  onChange={(event) =>
                    setNewChatForm((current) => ({ ...current, consentConfirmed: event.target.checked }))
                  }
                />
                <span>
                  I verified this person explicitly opted in to WhatsApp messages. I will not add opted-out or
                  unconsented contacts.
                </span>
              </label>
              <p className="form-hint">
                If the customer has not messaged first, only an approved template can start the chat. Creating this
                conversation does not send a message.
              </p>
              {startConversation.isError && (
                <div className="alert error" role="alert">
                  {startConversation.error instanceof Error
                    ? startConversation.error.message
                    : 'Unable to add this WhatsApp number.'}
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={startConversation.isPending}
                  onClick={closeNewChat}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    startConversation.isPending ||
                    !newChatForm.phoneNumber.trim() ||
                    !newChatForm.consentSource.trim() ||
                    !newChatForm.consentConfirmed
                  }
                >
                  {startConversation.isPending ? 'Adding…' : 'Add to conversations'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

type TemplateParameterField = {
  id: string;
  label: string;
  type: 'text' | 'image' | 'video' | 'document';
  componentType: string;
  componentIndex: number;
  parameterIndex: number;
  buttonIndex?: number;
  source: 'template' | 'default';
  defaultValue: string;
  placeholder: string;
};

function getTemplateFields(template: BasicRecord | undefined): TemplateParameterField[] {
  if (!template) return [];
  const metadata = Array.isArray(template.components)
    ? template.components.filter(isRecord)
    : [];
  const defaultComponents = Array.isArray(template.defaultSendComponents)
    ? template.defaultSendComponents.filter(isRecord)
    : [];
  const fields: TemplateParameterField[] = [];
  const defaultValue = (componentType: string, componentIndex: number, parameterIndex: number): string => {
    const component = defaultComponents.find(
      (item, index) => String(item.type ?? '').toLowerCase() === componentType && index === componentIndex,
    );
    const parameters = Array.isArray(component?.parameters) ? component.parameters : [];
    const parameter = parameters[parameterIndex];
    if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) return '';
    const item = parameter as Record<string, unknown>;
    const mediaType = ['image', 'video', 'document'].find((type) => type in item);
    if (mediaType) {
      const media = item[mediaType];
      return media && typeof media === 'object' && 'link' in media ? String(media.link) : '';
    }
    return typeof item.text === 'string' ? item.text : '';
  };
  const addField = (
    componentType: string,
    componentIndex: number,
    parameterIndex: number,
    type: TemplateParameterField['type'],
    label: string,
    source: TemplateParameterField['source'],
    buttonIndex?: number,
  ) => {
    const id = buttonIndex === undefined
      ? `${componentType}:${componentIndex}:${parameterIndex}`
      : `button:${componentIndex}:${buttonIndex}:${parameterIndex}`;
    fields.push({
      id,
      label,
      type,
      componentType,
      componentIndex,
      parameterIndex,
      ...(buttonIndex === undefined ? {} : { buttonIndex }),
      source,
      defaultValue: defaultValue(componentType, componentIndex, parameterIndex),
      placeholder: type === 'text' ? `Enter ${label.toLowerCase()}` : 'https://',
    });
  };

  metadata.forEach((component, componentIndex) => {
    const type = String(component.type ?? '').toUpperCase();
    if (type === 'BODY' || type === 'HEADER') {
      const format = String(component.format ?? '').toUpperCase();
      if (type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
        addField('header', componentIndex, 0, format.toLowerCase() as 'image' | 'video' | 'document', 'Header media URL', 'template');
      } else {
        const text = typeof component.text === 'string' ? component.text : '';
        const count = [...text.matchAll(/\{\{\s*\d+\s*\}\}/g)].length;
        for (let parameterIndex = 0; parameterIndex < count; parameterIndex += 1) {
          addField(
            type.toLowerCase(),
            componentIndex,
            parameterIndex,
            'text',
            `${type === 'BODY' ? 'Body' : 'Header'} parameter ${parameterIndex + 1}`,
            'template',
          );
        }
      }
    }
    if (type === 'BUTTONS' && Array.isArray(component.buttons)) {
      component.buttons.forEach((button, buttonIndex) => {
        if (!isRecord(button) || String(button.type).toUpperCase() !== 'URL') return;
        const url = typeof button.url === 'string' ? button.url : '';
        const count = [...url.matchAll(/\{\{\s*\d+\s*\}\}/g)].length;
        for (let parameterIndex = 0; parameterIndex < count; parameterIndex += 1) {
          addField('button', componentIndex, parameterIndex, 'text', `Button ${buttonIndex + 1} URL parameter`, 'template', buttonIndex);
        }
      });
    }
  });

  if (!fields.length) {
    defaultComponents.forEach((component, componentIndex) => {
      const componentType = String(component.type ?? '').toLowerCase();
      const parameters = Array.isArray(component.parameters) ? component.parameters : [];
      parameters.forEach((parameter, parameterIndex) => {
        if (!isRecord(parameter)) return;
        const mediaType = (['image', 'video', 'document'] as const).find((type) => type in parameter);
        addField(
          componentType,
          componentIndex,
          parameterIndex,
          mediaType ?? 'text',
          `${componentType || 'Template'} parameter ${parameterIndex + 1}${mediaType ? ' URL' : ''}`,
          'default',
        );
      });
    });
  }
  return fields;
}

function buildTemplateComponents(
  template: BasicRecord | undefined,
  fields: TemplateParameterField[],
  values: Record<string, string>,
): Array<Record<string, unknown>> {
  if (!template) return [];
  const getValue = (field: TemplateParameterField) => values[field.id] ?? field.defaultValue;
  if (fields.some((field) => field.source === 'default')) {
    const components = Array.isArray(template.defaultSendComponents)
      ? template.defaultSendComponents.filter(isRecord).map((component) => structuredClone(component))
      : [];
    for (const field of fields) {
      const component = components[field.componentIndex];
      if (!component || !Array.isArray(component.parameters)) continue;
      const parameter = component.parameters[field.parameterIndex];
      if (!isRecord(parameter)) continue;
      if (field.type === 'text') component.parameters[field.parameterIndex] = { type: 'text', text: getValue(field) };
      else component.parameters[field.parameterIndex] = {
        type: field.type,
        [field.type]: { link: getValue(field) },
      };
    }
    return components;
  }

  const components = new Map<string, Record<string, unknown>>();
  for (const field of fields) {
    const value = getValue(field);
    if (field.buttonIndex !== undefined) {
      const key = `button:${field.componentIndex}:${field.buttonIndex}`;
      const component = components.get(key) ?? {
        type: 'button',
        sub_type: 'url',
        index: String(field.buttonIndex),
        parameters: [] as Array<Record<string, unknown>>,
      };
      (component.parameters as Array<Record<string, unknown>>)[field.parameterIndex] = { type: 'text', text: value };
      components.set(key, component);
      continue;
    }
    const key = `${field.componentType}:${field.componentIndex}`;
    const component = components.get(key) ?? { type: field.componentType, parameters: [] as Array<Record<string, unknown>> };
    const parameters = component.parameters as Array<Record<string, unknown>>;
    parameters[field.parameterIndex] = field.type === 'text'
      ? { type: 'text', text: value }
      : { type: field.type, [field.type]: { link: value } };
    components.set(key, component);
  }
  return [...components.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isServiceWindowExpired(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const response = value.response;
  const data = isRecord(response) ? response.data : undefined;
  const error = isRecord(data) ? data.error : undefined;
  if (isRecord(error) && error.code === 'SERVICE_WINDOW_EXPIRED') return true;
  return typeof value.message === 'string' && value.message.toLowerCase().includes('service window has expired');
}

function formatCountdown(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function display(value: unknown): string {
  if (!value || typeof value !== 'object') return '—';
  const record = value as Record<string, unknown>;
  return String(record.profileName ?? record.name ?? record.phoneNumber ?? record.whatsappId ?? record.email ?? '—');
}
function customerPhone(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return String(record.phoneNumber ?? record.whatsappId ?? '');
}
function customerActivity(value: unknown): string {
  if (!value) return 'No recent WhatsApp activity';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return 'No recent WhatsApp activity';
  return `Last message ${formatRelativeDate(value)}`;
}
function conversationPreview(value: BasicRecord): string {
  const unreadCount = Number(value.unreadCount ?? 0);
  if (unreadCount > 0) return `${unreadCount} unread message${unreadCount === 1 ? '' : 's'}`;
  return `${String(value.status ?? 'OPEN')} · ${String(value.currentStep ?? 'Conversation')}`;
}
function formatRelativeDate(value: unknown): string {
  if (!value) return '—';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });
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
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}
function messageText(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '');
  const record = value as Record<string, unknown>;
  if (typeof record.caption === 'string') return record.caption;
  if (typeof record.imageUrl === 'string') return '';
  if (record.video && typeof record.video === 'object') {
    const video = record.video as Record<string, unknown>;
    return String(video.caption ?? 'Video attachment');
  }
  if (record.document && typeof record.document === 'object') {
    const document = record.document as Record<string, unknown>;
    return String(document.caption ?? document.filename ?? 'Document attachment');
  }
  if (record.image && typeof record.image === 'object') {
    const image = record.image as Record<string, unknown>;
    return String(image.caption ?? 'Image message');
  }
  if (record.interactive && typeof record.interactive === 'object') {
    const reply = record.interactive as Record<string, unknown>;
    return String(reply.title ?? reply.id ?? 'Interactive response');
  }
  if (record.button && typeof record.button === 'object') {
    const button = record.button as Record<string, unknown>;
    return String(button.text ?? button.payload ?? 'Button response');
  }
  const body = typeof record.text === 'string' ? record.text : '';
  if (Array.isArray(record.products)) {
    const names = record.products
      .map((product) =>
        product && typeof product === 'object' && 'name' in product ? String(product.name) : '',
      )
      .filter(Boolean);
    const list = names.length ? names.map((name) => `• ${name}`).join('\n') : 'Product catalogue sent';
    return [body, list].filter(Boolean).join('\n\n');
  }
  if (Array.isArray(record.categories)) {
    const names = record.categories
      .map((category) =>
        category && typeof category === 'object' && 'title' in category ? String(category.title) : '',
      )
      .filter(Boolean);
    const list = names.length ? names.map((name) => `• ${name}`).join('\n') : 'Product categories sent';
    return [body, list].filter(Boolean).join('\n\n');
  }
  if (body) return body;
  if (record.type === 'third-product-interest-trigger') {
    return 'We would be happy to help you choose the right product. Would you like to connect with our sales team?';
  }
  if (typeof record.type === 'string') return record.type.replace(/-/g, ' ');
  return 'Interactive message';
}
function messageButtons(value: unknown): Array<{ id: string; title: string }> {
  if (!value || typeof value !== 'object') return [];
  const buttons = (value as Record<string, unknown>).buttons;
  if (!Array.isArray(buttons)) return [];
  return buttons.flatMap((button) => {
    if (!button || typeof button !== 'object') return [];
    const record = button as Record<string, unknown>;
    if (typeof record.title !== 'string') return [];
    return [{ id: typeof record.id === 'string' ? record.id : record.title, title: record.title }];
  });
}
function messageImageUrl(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.imageUrl === 'string') return record.imageUrl;
  return messageMediaUrl(value, 'image');
}
function messageMediaUrl(value: unknown, type: 'image' | 'video'): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const media = record[type];
  if (!media || typeof media !== 'object') return '';
  const details = media as Record<string, unknown>;
  return typeof details.url === 'string' ? details.url : typeof details.link === 'string' ? details.link : '';
}
function messageDocument(value: unknown): { url: string; filename: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (!record.document || typeof record.document !== 'object') return undefined;
  const details = record.document as Record<string, unknown>;
  const url = typeof details.url === 'string' ? details.url : typeof details.link === 'string' ? details.link : '';
  return url ? { url, filename: typeof details.filename === 'string' ? details.filename : '' } : undefined;
}
function receiptLabel(value: unknown): string {
  switch (String(value)) {
    case 'QUEUED':
      return 'Sending…';
    case 'SENT':
      return 'Sent · awaiting delivery';
    case 'DELIVERED':
      return 'Delivered ✓✓';
    case 'READ':
      return 'Seen ✓✓';
    case 'FAILED':
      return 'Failed';
    default:
      return String(value ?? '');
  }
}
