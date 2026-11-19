import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
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
        <div className="table-toolbar leads-toolbar">
          <label className="table-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search customer, number, product, requirement, or lead ID…"
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
                      <strong>{display(lead.customerId)}</strong>
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
                    <span className={`status-chip ${lead.notificationStatus === 'SENT' ? 'on' : 'off'}`}>
                      {String(lead.notificationStatus ?? 'PENDING')}
                    </span>
                  </td>
                  <td>{formatDate(lead.createdAt)}</td>
                  <td>
                    {typeof lead.conversationId === 'string' && (
                      <Link
                        to={`/conversations?conversation=${encodeURIComponent(lead.conversationId)}`}
                        className="text-button lead-open-link"
                      >
                        Open chat
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
              {leads.data?.items.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty-row">
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

export function ConversationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const selectedId = searchParams.get('conversation') ?? '';
  const [reply, setReply] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templateComponents, setTemplateComponents] = useState('[]');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [attachment, setAttachment] = useState<File>();
  const [attachmentPreview, setAttachmentPreview] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
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
        (template) => template.metaStatus === 'APPROVED',
      ),
  });
  const selected = conversations.data?.find((conversation) => conversation._id === selectedId);
  const lastInteraction = selected?.lastInteractionAt ? new Date(String(selected.lastInteractionAt)).getTime() : 0;
  const serviceWindowOpen = lastInteraction > Date.now() - 24 * 60 * 60 * 1000;
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
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(['conversation-messages', selectedId], context.previous);
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
        {user?.role === 'ADMIN' && (
          <Link to="/bulk-campaigns" className="primary-button">
            Bulk message
          </Link>
        )}
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
                    {customerPhone(selected.customerId)} · {customerActivity(selected.lastInteractionAt)}
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
                    <small>
                      {outbound ? 'You' : display(selected?.customerId)} · {formatDate(message.timestamp)}
                      {outbound && (
                        <span className={`message-receipt ${String(message.status).toLowerCase()}`}>
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
          {selected && selected.status !== 'CLOSED' && (
            <section className="message-composer">
              {serviceWindowOpen ? (
                <form onSubmit={submitReply}>
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
                      WhatsApp customer service window · {(attachment ? 1024 : 4096) - reply.length} characters left
                    </span>
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
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
      return 'Sent ✓';
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
