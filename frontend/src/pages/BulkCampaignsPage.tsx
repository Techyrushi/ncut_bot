import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { ApiResponse, PageResult } from '../types/api';
import { useAuth } from '../contexts/AuthContext';

type CampaignRecord = Record<string, unknown> & { _id: string };
type UploadedMedia = { type: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; url: string; filename: string; mimeType: string };
type CampaignDetail = {
  campaign: CampaignRecord;
  recipients: PageResult<CampaignRecord>;
  statusCounts: Record<string, number>;
};

const recipientStatuses = ['UNSENT', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'];

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

function dateLabel(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  return new Date(value).toLocaleString();
}

export function BulkCampaignsPage() {
  const { user } = useAuth();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [recipientFile, setRecipientFile] = useState<File>();
  const [mediaFile, setMediaFile] = useState<File>();
  const [selectedId, setSelectedId] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [draftId, setDraftId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const campaigns = useQuery({
    queryKey: ['bulk-campaigns'],
    enabled: user?.role === 'ADMIN',
    queryFn: async () => (await api.get<ApiResponse<PageResult<CampaignRecord>>>('/bulk-campaigns')).data.data,
    refetchInterval: 5000,
  });
  const detail = useQuery({
    queryKey: ['bulk-campaign', selectedId, statusFilter, page],
    enabled: Boolean(selectedId) && user?.role === 'ADMIN',
    queryFn: async () => {
      const params: Record<string, string | number> = { page, limit: 25 };
      if (statusFilter !== 'ALL') params.status = statusFilter;
      return (await api.get<ApiResponse<CampaignDetail>>(`/bulk-campaigns/${selectedId}`, { params })).data.data;
    },
    refetchInterval:
      detailCampaignStatus(['QUEUED', 'PROCESSING'], campaigns.data?.items, selectedId) ? 2500 : false,
  });

  async function uploadRecipients(campaignId: string): Promise<void> {
    if (!recipientFile) throw new Error('Choose a CSV or XLSX file with recipient phone numbers.');
    const extension = recipientFile.name.toLowerCase().split('.').pop();
    const contentType =
      extension === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    await api.post(`/bulk-campaigns/${campaignId}/import`, recipientFile, {
      headers: { 'Content-Type': contentType },
    });
  }

  async function createAndPreview(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!recipientFile) {
      setError('Choose a CSV or XLSX file with recipient phone numbers.');
      return;
    }
    if (!message.trim() && !mediaFile) {
      setError('Add a message or attachment before continuing.');
      return;
    }
    if (mediaFile && message.trim().length > 1024) {
      setError('A message with an attachment can be at most 1,024 characters.');
      return;
    }
    setBusy(true);
    try {
      let attachment: UploadedMedia | undefined;
      if (mediaFile) {
        const extension = mediaFile.name.toLowerCase().split('.').pop();
        const contentType = mediaFile.type || (extension === 'mp4' ? 'video/mp4' : 'application/octet-stream');
        const upload = await api.post<ApiResponse<UploadedMedia>>('/bulk-campaigns/media', mediaFile, {
          headers: { 'Content-Type': contentType, 'X-File-Name': mediaFile.name },
        });
        attachment = upload.data.data;
      }
      const created = await api.post<ApiResponse<CampaignRecord>>('/bulk-campaigns', {
        name: name.trim() || `Bulk message ${new Date().toLocaleDateString()}`,
        message: message.trim(),
        ...(attachment ? { attachment } : {}),
      });
      const id = created.data.data._id;
      setDraftId(id);
      await uploadRecipients(id);
      setDraftId('');
      setSelectedId(id);
      setPage(1);
      setStatusFilter('ALL');
      setNotice('Recipient preview is ready. Review eligibility and excluded contacts before sending.');
      setName('');
      setMessage('');
      setRecipientFile(undefined);
      setMediaFile(undefined);
      await client.invalidateQueries({ queryKey: ['bulk-campaigns'] });
      await client.invalidateQueries({ queryKey: ['bulk-campaign', id] });
    } catch (requestError) {
      setError(getErrorMessage(requestError));
      await client.invalidateQueries({ queryKey: ['bulk-campaigns'] });
    } finally {
      setBusy(false);
    }
  }

  async function retryImport(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draftId) return;
    setBusy(true);
    setError('');
    try {
      await uploadRecipients(draftId);
      const id = draftId;
      setDraftId('');
      setSelectedId(id);
      setPage(1);
      setStatusFilter('ALL');
      setNotice('Recipient preview is ready. Review eligibility and excluded contacts before sending.');
      setRecipientFile(undefined);
      await client.invalidateQueries({ queryKey: ['bulk-campaigns'] });
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function sendCampaign(): Promise<void> {
    if (!selectedId || !detail.data) return;
    const eligible = detail.data.campaign.eligibleRecipients;
    if (typeof eligible !== 'number' || eligible < 1) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/bulk-campaigns/${selectedId}/send`);
      setNotice(`Campaign queued for ${eligible} eligible recipients. Delivery updates will appear below.`);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['bulk-campaigns'] }),
        client.invalidateQueries({ queryKey: ['bulk-campaign', selectedId] }),
      ]);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function exportRecipients(): Promise<void> {
    if (!selectedId) return;
    try {
      const response = await api.get(`/bulk-campaigns/${selectedId}/export.csv`, {
        params: statusFilter !== 'ALL' ? { status: statusFilter } : {},
        responseType: 'blob',
      });
      const url = URL.createObjectURL(response.data as Blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ncut-campaign-${selectedId}-${statusFilter.toLowerCase()}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    }
  }

  if (user?.role !== 'ADMIN') {
    return <section className="panel"><h1>Administrator access required</h1><p>Bulk campaigns are available to administrators only.</p></section>;
  }

  const selectedCampaign = detail.data?.campaign;
  const counts = detail.data?.statusCounts ?? {};
  const isReady = selectedCampaign?.status === 'READY';
  const eligibleCount = Number(selectedCampaign?.eligibleRecipients ?? 0);
  const unsentCount = isReady ? Math.max(0, (counts.UNSENT ?? 0) - eligibleCount) : counts.UNSENT ?? 0;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CUSTOMER MESSAGING / CAMPAIGNS</div>
          <h1>Bulk messages</h1>
          <p>Import recipients, preview consent and service-window eligibility, then track delivery per contact.</p>
        </div>
      </div>
      {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>×</button></div>}
      {notice && <div className="alert" role="status">{notice}<button type="button" onClick={() => setNotice('')}>×</button></div>}
      {draftId && (
        <form className="panel campaign-retry-import" onSubmit={retryImport}>
          <div>
            <h2>Campaign created; recipient import needs attention</h2>
            <p>Re-select a valid CSV or XLSX file to finish the preview. Nothing has been sent.</p>
          </div>
          <label className="campaign-file-label">
            Recipient spreadsheet
            <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setRecipientFile(event.target.files?.[0])} />
          </label>
          <button type="submit" className="primary-button" disabled={busy || !recipientFile}>Retry preview</button>
        </form>
      )}
      <div className="campaign-layout">
        <form className="panel campaign-create-form" onSubmit={createAndPreview}>
          <div className="eyebrow">NEW CAMPAIGN</div>
          <h2>Compose and preview</h2>
          <label>
            Campaign name
            <input maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. March product update" />
          </label>
          <label>
            Message or attachment caption
            <textarea maxLength={mediaFile ? 1024 : 4096} rows={5} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Write the WhatsApp message…" />
            <span className="form-hint">{message.length}/{mediaFile ? 1024 : 4096} characters</span>
          </label>
          <label className="campaign-file-label">
            Optional image, video, or document
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.mp4,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,image/jpeg,image/png,video/mp4,application/pdf"
              onChange={(event) => setMediaFile(event.target.files?.[0])}
            />
            <span className="form-hint">Images up to 5 MB, MP4 video up to 16 MB, documents up to 20 MB.</span>
          </label>
          <label className="campaign-file-label">
            Recipient spreadsheet <span className="required-mark">*</span>
            <input
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required={!recipientFile}
              onChange={(event) => setRecipientFile(event.target.files?.[0])}
            />
            <span className="form-hint">CSV or XLSX, phone/mobile column or first column, up to 500 unique recipients.</span>
          </label>
          {mediaFile && <div className="campaign-file-summary">{mediaFile.name} · {(mediaFile.size / (1024 * 1024)).toFixed(2)} MB <button type="button" onClick={() => setMediaFile(undefined)}>Remove</button></div>}
          {recipientFile && <div className="campaign-file-summary">{recipientFile.name} · {(recipientFile.size / (1024 * 1024)).toFixed(2)} MB <button type="button" onClick={() => setRecipientFile(undefined)}>Remove</button></div>}
          <div className="campaign-policy-note">
            Only existing customers with recorded opt-in and an open 24-hour service window are eligible. Other rows are recorded as unsent; no template messages are sent by this campaign.
          </div>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Preparing preview…' : 'Create preview'}
          </button>
        </form>
        <section className="panel campaign-history">
          <div className="panel-heading">
            <div><div className="eyebrow">CAMPAIGN HISTORY</div><h2>{campaigns.data?.total ?? 0} campaigns</h2></div>
          </div>
          {campaigns.isError && <p className="form-error" role="alert">{getErrorMessage(campaigns.error)}</p>}
          {campaigns.isLoading ? <p className="form-hint">Loading campaign history…</p> : (campaigns.data?.items ?? []).length ? (
            <div className="campaign-history-list">
              {(campaigns.data?.items ?? []).map((campaign) => (
                <button
                  type="button"
                  className={`campaign-history-item ${campaign._id === selectedId ? 'selected' : ''}`}
                  key={campaign._id}
                  onClick={() => { setSelectedId(campaign._id); setDraftId(campaign.status === 'DRAFT' ? campaign._id : ''); setPage(1); setStatusFilter('ALL'); setError(''); }}
                >
                  <span className="campaign-history-copy">
                    <strong>{String(campaign.name)}</strong>
                    <small>{dateLabel(campaign.createdAt)} · {String(campaign.status)}</small>
                  </span>
                  <span className="campaign-history-count">{Number(campaign.eligibleRecipients ?? 0)} eligible</span>
                </button>
              ))}
            </div>
          ) : <p className="campaign-empty">Campaign previews and delivery activity will appear here.</p>}
        </section>
      </div>
      {selectedCampaign && (
        <section className="panel campaign-detail">
          <div className="panel-heading campaign-detail-heading">
            <div><div className="eyebrow">DELIVERY ACTIVITY</div><h2>{String(selectedCampaign.name)}</h2><p>{String(selectedCampaign.status)} · Created {dateLabel(selectedCampaign.createdAt)}</p></div>
            {isReady && (
              <button type="button" className="primary-button" disabled={busy || Number(selectedCampaign.eligibleRecipients ?? 0) < 1} onClick={sendCampaign}>
                Send to {Number(selectedCampaign.eligibleRecipients ?? 0)} eligible
              </button>
            )}
          </div>
          {isReady && (
            <div className="campaign-preview-notice">
              <strong>Preview before sending</strong>
              <span>{Number(selectedCampaign.inputRows ?? 0)} rows · {Number(selectedCampaign.duplicateRows ?? 0)} duplicates skipped · {eligibleCount} eligible · {unsentCount} excluded/unsent</span>
            </div>
          )}
          <div className="campaign-stat-grid">
            {['ELIGIBLE', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNSENT'].map((status) => (
              <div className="campaign-stat" key={status}><span>{status}</span><strong>{status === 'ELIGIBLE' ? eligibleCount : status === 'UNSENT' ? unsentCount : counts[status] ?? 0}</strong></div>
            ))}
          </div>
          {selectedCampaign.status === 'DRAFT' && (
            <form className="campaign-draft-import" onSubmit={retryImport}>
              <label className="campaign-file-label">Import recipients to preview
                <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required onChange={(event) => setRecipientFile(event.target.files?.[0])} />
              </label>
              <button type="submit" className="secondary-button" disabled={busy || !recipientFile}>Import and preview</button>
            </form>
          )}
          <div className="campaign-recipient-toolbar">
            <label className="filter-control"><span>Recipient status</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}><option value="ALL">All statuses</option>{recipientStatuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
            <button type="button" className="secondary-button" onClick={exportRecipients}>Export {statusFilter === 'ALL' ? 'all' : statusFilter.toLowerCase()} rows</button>
          </div>
          {detail.isError && <p className="form-error" role="alert">{getErrorMessage(detail.error)}</p>}
          <div className="table-scroll">
            <table className="admin-data-table campaign-recipient-table">
              <thead><tr><th>PHONE</th><th>CUSTOMER</th><th>STATUS</th><th>RESULT / REASON</th><th>ATTEMPTS</th><th>LAST UPDATE</th></tr></thead>
              <tbody>
                {(detail.data?.recipients.items ?? []).map((recipient) => {
                  const customer = recipient.customerId && typeof recipient.customerId === 'object' ? recipient.customerId as Record<string, unknown> : {};
                  return <tr key={recipient._id}>
                    <td>{String(recipient.phoneNumber)}</td>
                    <td>{String(customer.profileName ?? customer.name ?? '—')}</td>
                    <td><span className={`status-chip ${['SENT', 'DELIVERED', 'READ'].includes(String(recipient.status)) ? 'on' : 'off'}`}>{String(recipient.status)}</span></td>
                    <td>{String(recipient.lastError ?? recipient.reason ?? (recipient.eligible ? 'Eligible for send' : '—'))}</td>
                    <td>{Number(recipient.attempts ?? 0)}</td>
                    <td>{dateLabel(recipient.updatedAt)}</td>
                  </tr>;
                })}
                {!detail.isLoading && (detail.data?.recipients.items ?? []).length === 0 && <tr><td colSpan={6} className="empty-row">No recipients match this status.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="table-pagination">
            <span>{detail.data?.recipients.total ?? 0} recipients</span>
            <div>
              <button type="button" className="secondary-button" disabled={page <= 1 || detail.isFetching} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button>
              <button type="button" className="secondary-button" disabled={page >= Math.ceil((detail.data?.recipients.total ?? 0) / (detail.data?.recipients.limit ?? 25)) || detail.isFetching} onClick={() => setPage((value) => value + 1)}>Next</button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function detailCampaignStatus(
  activeStatuses: string[],
  items: CampaignRecord[] | undefined,
  selectedId: string,
): boolean {
  const campaign = items?.find((item) => item._id === selectedId);
  return activeStatuses.includes(String(campaign?.status ?? ''));
}
