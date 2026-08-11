import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, downloadReport } from './api';
import {
  formatDate,
  formatDuration,
  formatTime,
  localDate,
  toBrisbaneLocalInput,
  todayBrisbane,
} from './format';
import type {
  Catalog,
  DashboardData,
  Entry,
  HistoryData,
  PracticeData,
  SessionData,
  SignedInUser,
  WorkPayload,
} from './types';

type View = 'dashboard' | 'history' | 'reports' | 'practice';
type WorkForm = {
  workType: 'client' | 'internal';
  clientId: string;
  jobId: string;
  internalActivityId: string;
  billable: boolean;
  notes: string;
};
function emptyWork(catalog?: Catalog): WorkForm {
  const recentJob = catalog?.jobs.find(
    (job) => job.id === localStorage.getItem('timekeeper:last-job'),
  );
  return {
    workType: 'client',
    clientId: recentJob?.clientId ?? '',
    jobId: recentJob?.id ?? '',
    internalActivityId: catalog?.internalActivities[0]?.id ?? '',
    billable: recentJob?.defaultBillable ?? true,
    notes: '',
  };
}
function payload(value: WorkForm): WorkPayload {
  return value.workType === 'client'
    ? {
        workType: 'client',
        clientId: value.clientId,
        jobId: value.jobId,
        billable: value.billable,
        notes: value.notes,
      }
    : {
        workType: 'internal',
        internalActivityId: value.internalActivityId,
        billable: false,
        notes: value.notes,
      };
}
function formFromEntry(entry: Entry | null, catalog: Catalog): WorkForm {
  if (entry?.workType === 'client')
    return {
      workType: 'client',
      clientId: entry.clientId ?? '',
      jobId: entry.jobId ?? '',
      internalActivityId: catalog.internalActivities[0]?.id ?? '',
      billable: entry.billable,
      notes: entry.notes,
    };
  return {
    workType: 'internal',
    clientId: '',
    jobId: '',
    internalActivityId: entry?.internalActivityId ?? catalog.internalActivities[0]?.id ?? '',
    billable: false,
    notes: entry?.notes ?? '',
  };
}

function WorkFields({
  value,
  onChange,
  catalog,
  compact = false,
}: {
  value: WorkForm;
  onChange: (value: WorkForm) => void;
  catalog: Catalog;
  compact?: boolean;
}) {
  const [clientSearch, setClientSearch] = useState('');
  const [matchedClients, setMatchedClients] = useState(catalog.clients);
  useEffect(() => {
    const query = clientSearch.trim();
    if (query.length < 2) {
      setMatchedClients(catalog.clients);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      api<Catalog>(`/api/catalog?search=${encodeURIComponent(query)}`)
        .then((result) => current && setMatchedClients(result.clients))
        .catch(() => current && setMatchedClients(catalog.clients));
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [catalog.clients, clientSearch]);
  const clients = useMemo(() => matchedClients, [matchedClients]);
  const jobs = useMemo(
    () => catalog.jobs.filter((job) => job.clientId === value.clientId),
    [catalog.jobs, value.clientId],
  );
  const chooseClient = (clientId: string) =>
    onChange({ ...value, clientId, jobId: '', billable: true });
  const chooseJob = (jobId: string) => {
    const job = catalog.jobs.find((item) => item.id === jobId);
    onChange({ ...value, jobId, billable: job?.defaultBillable ?? true });
    if (jobId) localStorage.setItem('timekeeper:last-job', jobId);
  };
  return (
    <div className={`work-fields ${compact ? 'compact-fields' : ''}`}>
      <fieldset className="work-type">
        <legend>Work type</legend>
        <button
          type="button"
          className={value.workType === 'client' ? 'selected' : ''}
          onClick={() => onChange({ ...value, workType: 'client' })}
        >
          Client work
        </button>
        <button
          type="button"
          className={value.workType === 'internal' ? 'selected' : ''}
          onClick={() => onChange({ ...value, workType: 'internal', billable: false })}
        >
          Internal work
        </button>
      </fieldset>
      {value.workType === 'client' ? (
        <>
          <label>
            Client
            <input
              className="catalog-search"
              value={clientSearch}
              onChange={(event) => setClientSearch(event.target.value)}
              placeholder="Search clients"
              aria-label="Search clients"
            />
            <select
              value={value.clientId}
              onChange={(event) => chooseClient(event.target.value)}
              required
            >
              <option value="">Choose client</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                  {client.clientCode ? ` (${client.clientCode})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Project / activity
            <select
              value={value.jobId}
              onChange={(event) => chooseJob(event.target.value)}
              required
              disabled={!value.clientId}
            >
              <option value="">
                {value.clientId ? 'Choose FYI job' : 'Choose a client first'}
              </option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.name}
                  {job.jobCode ? ` (${job.jobCode})` : ''}
                </option>
              ))}
            </select>
            {value.clientId && !jobs.length && (
              <small className="field-help">
                No active FYI jobs are available for this client. Ask an admin to sync FYI.
              </small>
            )}
          </label>
          <label className="billable-control">
            <input
              type="checkbox"
              checked={value.billable}
              onChange={(event) => onChange({ ...value, billable: event.target.checked })}
            />{' '}
            Billable
          </label>
        </>
      ) : (
        <label>
          Internal activity
          <select
            value={value.internalActivityId}
            onChange={(event) => onChange({ ...value, internalActivityId: event.target.value })}
            required
          >
            <option value="">Choose activity</option>
            {catalog.internalActivities.map((activity) => (
              <option key={activity.id} value={activity.id}>
                {activity.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="notes-field">
        Notes <span>Optional</span>
        <input
          value={value.notes}
          onChange={(event) => onChange({ ...value, notes: event.target.value })}
          maxLength={2000}
          placeholder="What are you working on?"
        />
      </label>
    </div>
  );
}

function EntryRows({
  entries,
  now,
  onEdit,
  onDelete,
  canEdit = () => true,
}: {
  entries: Entry[];
  now: number;
  onEdit?: (entry: Entry) => void;
  onDelete?: (entry: Entry) => void;
  canEdit?: (entry: Entry) => boolean;
}) {
  if (!entries.length) return <div className="empty">No time entries here yet.</div>;
  return (
    <div className="entry-list">
      {entries.map((entry) => {
        const elapsed = Math.max(
          0,
          (entry.endAt ? Date.parse(entry.endAt) : now) - Date.parse(entry.startAt),
        );
        return (
          <article className="entry-row" key={entry.id}>
            <div className="entry-main">
              <div className="entry-title">
                <strong>
                  {entry.clientName ??
                    (entry.workType === 'internal' ? 'Internal' : 'Legacy entry')}
                </strong>
                <span>{entry.jobName ?? entry.activityName ?? entry.projectName}</span>
              </div>
              <div className="entry-meta">
                <span>{entry.userDisplayName}</span>
                <span>
                  {formatTime(entry.startAt)} - {entry.endAt ? formatTime(entry.endAt) : 'Running'}
                </span>
                <span className={`tag ${entry.billable ? 'billable' : ''}`}>
                  {entry.billable ? 'Billable' : 'Non-billable'}
                </span>
                {entry.legacy && <span className="tag warning">Legacy</span>}
              </div>
              {entry.notes && <p>{entry.notes}</p>}
            </div>
            <div className="entry-side">
              <strong>{formatDuration(elapsed)}</strong>
              {entry.endAt && onEdit && onDelete && canEdit(entry) && (
                <div className="row-actions">
                  <button className="link-button" onClick={() => onEdit(entry)}>
                    Edit
                  </button>
                  <button className="link-button danger-text" onClick={() => onDelete(entry)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function EntryDialog({
  entry,
  catalog,
  onClose,
  onSave,
}: {
  entry: Entry | null;
  catalog: Catalog;
  onClose: () => void;
  onSave: (data: WorkPayload & { startLocal: string; endLocal: string }) => Promise<void>;
}) {
  const current = new Date();
  const oneHourAgo = new Date(current.getTime() - 3_600_000);
  const [work, setWork] = useState(() => formFromEntry(entry, catalog));
  const [startLocal, setStartLocal] = useState(
    entry ? toBrisbaneLocalInput(entry.startAt) : toBrisbaneLocalInput(oneHourAgo.toISOString()),
  );
  const [endLocal, setEndLocal] = useState(
    entry?.endAt ? toBrisbaneLocalInput(entry.endAt) : toBrisbaneLocalInput(current.toISOString()),
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onSave({ ...payload(work), startLocal, endLocal });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save the entry.');
      setSaving(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="entry-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Completed time</p>
            <h2 id="entry-title">{entry ? 'Edit entry' : 'Add time entry'}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {entry?.legacy && (
          <div className="message warning">Classify this legacy entry before saving.</div>
        )}
        <form onSubmit={submit} className="form-grid">
          <div className="span-2">
            <WorkFields value={work} onChange={setWork} catalog={catalog} />
          </div>
          <label>
            Clock in <span className="timezone">Brisbane</span>
            <input
              type="datetime-local"
              value={startLocal}
              onChange={(event) => setStartLocal(event.target.value)}
              required
            />
          </label>
          <label>
            Clock out <span className="timezone">Brisbane</span>
            <input
              type="datetime-local"
              value={endLocal}
              onChange={(event) => setEndLocal(event.target.value)}
              required
            />
          </label>
          {error && (
            <div className="message error span-2" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions span-2">
            <button type="button" className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save entry'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Dashboard({
  data,
  csrf,
  refresh,
  now,
  editEntry,
  deleteEntry,
}: {
  data: DashboardData;
  csrf: string;
  refresh: () => Promise<void>;
  now: number;
  editEntry: (entry: Entry) => void;
  deleteEntry: (entry: Entry) => void;
}) {
  const [work, setWork] = useState(() => emptyWork(data.catalog));
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  useEffect(() => {
    if (!work.internalActivityId && data.catalog.internalActivities[0])
      setWork((value) => ({ ...value, internalActivityId: data.catalog.internalActivities[0].id }));
  }, [data.catalog.internalActivities, work.internalActivityId]);
  async function clockIn(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setMessage(null);
    try {
      await api('/api/clock-in', { method: 'POST', body: JSON.stringify(payload(work)) }, csrf);
      setWork((value) => ({ ...value, notes: '' }));
      await refresh();
      setMessage({ kind: 'success', text: 'Clocked in successfully.' });
    } catch (caught) {
      setMessage({
        kind: 'error',
        text: caught instanceof Error ? caught.message : 'Unable to clock in.',
      });
    } finally {
      setWorking(false);
    }
  }
  async function clockOut() {
    setWorking(true);
    setMessage(null);
    try {
      await api('/api/clock-out', { method: 'POST' }, csrf);
      await refresh();
      setMessage({ kind: 'success', text: 'Clocked out successfully.' });
    } catch (caught) {
      setMessage({
        kind: 'error',
        text: caught instanceof Error ? caught.message : 'Unable to clock out.',
      });
    } finally {
      setWorking(false);
    }
  }
  const activeMs = data.active ? now - Date.parse(data.active.startAt) : 0;
  return (
    <>
      <section className={`timer-card ${data.active ? 'active' : ''}`}>
        <div className="timer-status">
          <span className={`status-dot ${data.active ? 'live' : ''}`} />
          {data.active ? 'Timer running' : 'Ready to start'}
        </div>
        {data.active ? (
          <div className="active-timer">
            <div>
              <p className="eyebrow">
                {data.active.clientName ??
                  (data.active.workType === 'internal' ? 'Internal' : 'Legacy')}
              </p>
              <h1>{data.active.jobName ?? data.active.activityName ?? data.active.projectName}</h1>
              <div className="timer-digits">{formatDuration(activeMs)}</div>
              <p className="muted">
                Started {formatTime(data.active.startAt)} on {formatDate(data.active.startAt)}
              </p>
              {data.active.notes && <p className="active-notes">{data.active.notes}</p>}
            </div>
            <button className="button attention large" onClick={clockOut} disabled={working}>
              {working ? 'Stopping...' : 'Clock out'}
            </button>
          </div>
        ) : data.catalog.clients.length || data.catalog.internalActivities.length ? (
          <form onSubmit={clockIn} className="clock-form">
            <WorkFields value={work} onChange={setWork} catalog={data.catalog} compact />
            <button className="button gold large clock-action" disabled={working}>
              {working ? 'Starting...' : 'Clock in'}
            </button>
          </form>
        ) : (
          <div className="catalog-empty">
            <strong>No work catalogue is available yet.</strong>
            <p>
              An administrator can sync FYI or import the client and job CSV. Internal activities
              remain available after the database migration.
            </p>
          </div>
        )}
        {message && (
          <div
            className={`message ${message.kind}`}
            role={message.kind === 'error' ? 'alert' : 'status'}
          >
            {message.text}
          </div>
        )}
      </section>
      <div className="metric-grid">
        <Metric
          label="Today"
          value={formatDuration(data.today.totalMs)}
          detail={`${data.today.entries.length} entries`}
        />
        <Metric
          label="This week"
          value={formatDuration(data.week.totalMs)}
          detail={`${formatDate(data.week.start)} - ${formatDate(data.week.end)}`}
        />
        <Metric
          label="Billable"
          value={formatDuration(data.week.billableMs)}
          detail={`${data.week.utilisationPercent}% utilisation`}
        />
        <Metric label="Internal" value={formatDuration(data.week.internalMs)} detail="This week" />
      </div>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{formatDate(data.today.date)}</p>
              <h2>Today's entries</h2>
            </div>
            <span className="total-rule">{formatDuration(data.today.totalMs)}</span>
          </div>
          <EntryRows
            entries={data.today.entries}
            now={now}
            onEdit={editEntry}
            onDelete={deleteEntry}
          />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Monday to Sunday</p>
              <h2>Weekly mix</h2>
            </div>
          </div>
          <div className="utilisation">
            <strong>{data.week.utilisationPercent}%</strong>
            <span>Billable utilisation</span>
            <div>
              <i style={{ width: `${Math.min(100, data.week.utilisationPercent)}%` }} />
            </div>
          </div>
          <TotalsList
            items={data.week.jobTotals.slice(0, 6)}
            empty="No classified time this week."
          />
        </section>
      </div>
    </>
  );
}
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className="metric-card">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </section>
  );
}
function TotalsList({
  items,
  empty,
}: {
  items: { name: string; totalMs: number }[];
  empty: string;
}) {
  return items.length ? (
    <div className="totals-list">
      {items.map((item) => (
        <div key={item.name}>
          <span>{item.name}</span>
          <strong>{formatDuration(item.totalMs)}</strong>
        </div>
      ))}
    </div>
  ) : (
    <div className="empty">{empty}</div>
  );
}

function History({
  catalog,
  user,
  users,
  refreshKey,
  editEntry,
  deleteEntry,
}: {
  catalog: Catalog;
  user: SignedInUser;
  users: SignedInUser[];
  refreshKey: number;
  editEntry: (entry: Entry) => void;
  deleteEntry: (entry: Entry) => void;
}) {
  const today = todayBrisbane();
  const initial = new Date(`${today}T00:00:00+10:00`);
  initial.setDate(initial.getDate() - 29);
  const [filters, setFilters] = useState({
    from: localDate(initial.toISOString()),
    to: today,
    clientId: '',
    jobId: '',
    workType: '',
    billable: '',
    userId: '',
    internalActivityId: '',
  });
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ from: filters.from, to: filters.to });
      Object.entries(filters).forEach(
        ([key, value]) => value && !['from', 'to'].includes(key) && query.set(key, value),
      );
      if (user.role === 'admin') query.set('scope', 'all');
      setData(await api(`/api/entries?${query}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load history.');
    } finally {
      setLoading(false);
    }
  }, [filters, user.role]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  const groups = useMemo(() => {
    const result = new Map<string, Entry[]>();
    for (const entry of data?.entries ?? []) {
      const date = localDate(entry.startAt);
      result.set(date, [...(result.get(date) ?? []), entry]);
    }
    return result;
  }, [data]);
  const set = (key: keyof typeof filters, value: string) =>
    setFilters((current) => ({
      ...current,
      [key]: value,
      ...(key === 'clientId' ? { jobId: '' } : {}),
    }));
  return (
    <section className="panel history-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Search and correct records</p>
          <h2>History</h2>
        </div>
        {data && <span className="total-rule">{formatDuration(data.totalMs)}</span>}
      </div>
      <div className="filters">
        <label>
          From
          <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label>
          Work type
          <select value={filters.workType} onChange={(e) => set('workType', e.target.value)}>
            <option value="">All work</option>
            <option value="client">Client work</option>
            <option value="internal">Internal work</option>
            <option value="legacy">Legacy</option>
          </select>
        </label>
        <label>
          Client
          <select value={filters.clientId} onChange={(e) => set('clientId', e.target.value)}>
            <option value="">All clients</option>
            {catalog.clients.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Job
          <select value={filters.jobId} onChange={(e) => set('jobId', e.target.value)}>
            <option value="">All jobs</option>
            {catalog.jobs
              .filter((job) => !filters.clientId || job.clientId === filters.clientId)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Billable
          <select value={filters.billable} onChange={(e) => set('billable', e.target.value)}>
            <option value="">All</option>
            <option value="true">Billable</option>
            <option value="false">Non-billable</option>
          </select>
        </label>
        {user.role === 'admin' && (
          <label>
            Employee
            <select value={filters.userId} onChange={(e) => set('userId', e.target.value)}>
              <option value="">All employees</option>
              {users.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && <div className="message error">{error}</div>}
      {loading ? (
        <div className="loading">Loading history...</div>
      ) : groups.size ? (
        [...groups].map(([date, entries]) => (
          <div className="date-group" key={date}>
            <div className="date-heading">
              <h3>{formatDate(date)}</h3>
              <span>
                {formatDuration(
                  entries.reduce(
                    (sum, entry) =>
                      sum +
                      Math.max(
                        0,
                        Date.parse(entry.endAt ?? new Date().toISOString()) -
                          Date.parse(entry.startAt),
                      ),
                    0,
                  ),
                )}
              </span>
            </div>
            <EntryRows
              entries={entries}
              now={Date.now()}
              onEdit={editEntry}
              onDelete={deleteEntry}
              canEdit={(entry) => entry.userId === user.id}
            />
          </div>
        ))
      ) : (
        <div className="empty large-empty">
          <strong>No matching entries</strong>
          <span>Try a wider date range or fewer filters.</span>
        </div>
      )}
      {data && (
        <div className="history-summary">
          <h3>Range summary</h3>
          <div className="summary-stats">
            <span>
              Client <strong>{formatDuration(data.clientMs)}</strong>
            </span>
            <span>
              Internal <strong>{formatDuration(data.internalMs)}</strong>
            </span>
            <span>
              Billable <strong>{formatDuration(data.billableMs)}</strong>
            </span>
            <span>
              Utilisation <strong>{data.utilisationPercent}%</strong>
            </span>
          </div>
          <TotalsList items={data.clientTotals} empty="No client totals." />
        </div>
      )}
    </section>
  );
}

function Reports({ csrf }: { csrf: string }) {
  const [week, setWeek] = useState(todayBrisbane());
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  async function download() {
    setBusy('download');
    setMessage('');
    try {
      await downloadReport(week);
      setMessage('Excel report downloaded successfully.');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Unable to download report.');
    } finally {
      setBusy('');
    }
  }
  async function send() {
    setBusy('send');
    setMessage('');
    try {
      const result = await api<{ sent: boolean; reason?: string }>(
        '/api/reports/test-email',
        { method: 'POST', body: JSON.stringify({ weekStart: week }) },
        csrf,
      );
      setMessage(
        result.sent
          ? 'Test report emailed successfully.'
          : 'This test report has already been sent.',
      );
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Unable to send report.');
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel report-panel">
      <div className="report-hero">
        <div className="report-icon">X</div>
        <div>
          <p className="eyebrow">Monday to Sunday</p>
          <h2>Weekly Excel report</h2>
          <p className="muted">
            Client, job, billable, employee and external-ID detail with daily and weekly summaries.
          </p>
        </div>
      </div>
      <div className="report-controls">
        <label>
          Choose any date in the week
          <input type="date" value={week} onChange={(e) => setWeek(e.target.value)} />
        </label>
        <div className="report-buttons">
          <button className="button secondary" onClick={send} disabled={Boolean(busy)}>
            {busy === 'send' ? 'Sending...' : 'Send test email'}
          </button>
          <button className="button gold" onClick={download} disabled={Boolean(busy)}>
            {busy === 'download' ? 'Preparing...' : 'Download .xlsx'}
          </button>
        </div>
      </div>
      {message && (
        <div className={`message ${message.includes('Unable') ? 'error' : 'success'}`}>
          {message}
        </div>
      )}
      <div className="report-details">
        <div>
          <strong>Brisbane time</strong>
          <span>Cross-midnight work is allocated to the correct local day.</span>
        </div>
        <div>
          <strong>Practice-ready</strong>
          <span>Client and job external IDs support later WIP reconciliation.</span>
        </div>
        <div>
          <strong>Brand aligned</strong>
          <span>Archivo, Ledger Ink, Sand and restrained Versatile Gold.</span>
        </div>
      </div>
    </section>
  );
}

function Practice({ csrf }: { csrf: string }) {
  const [data, setData] = useState<PracticeData | null>(null);
  const [exceptions, setExceptions] = useState<{ entry: Entry; reasons: string[] }[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [newActivity, setNewActivity] = useState('');
  const load = useCallback(async () => {
    const [practice, exceptionData] = await Promise.all([
      api<PracticeData>('/api/admin/practice'),
      api<{ exceptions: { entry: Entry; reasons: string[] }[] }>('/api/admin/exceptions'),
    ]);
    setData(practice);
    setExceptions(exceptionData.exceptions);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function sync() {
    setBusy(true);
    setMessage('');
    try {
      await api('/api/admin/fyi-sync', { method: 'POST' }, csrf);
      setMessage('FYI sync completed.');
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'FYI sync failed.');
    } finally {
      setBusy(false);
    }
  }
  async function importCsv(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage('');
    try {
      const csv = await file.text();
      await api(
        '/api/admin/catalog-import',
        { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv },
        csrf,
      );
      setMessage('CSV catalogue imported.');
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'CSV import failed.');
    } finally {
      setBusy(false);
    }
  }
  async function saveActivity(name: string, active: boolean, id?: string) {
    await api(
      '/api/admin/internal-activities',
      { method: 'POST', body: JSON.stringify({ id, name, active }) },
      csrf,
    );
    setNewActivity('');
    await load();
  }
  async function setDefault(id: string, billable: boolean) {
    await api(
      `/api/admin/jobs/${id}/billable-default`,
      { method: 'PUT', body: JSON.stringify({ billable }) },
      csrf,
    );
    await load();
  }
  if (!data) return <div className="loading">Loading practice settings...</div>;
  const syncSummary = data.latestSync
    ? `${data.latestSync.status} ${new Date(data.latestSync.startedAt).toLocaleString('en-AU')}`
    : 'Never synced';
  return (
    <div className="practice-grid">
      <section className="panel span-wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Read-only master data</p>
            <h2>FYI clients and jobs</h2>
          </div>
          <span className={`sync-badge ${data.latestSync?.status ?? ''}`}>{syncSummary}</span>
        </div>
        <p className="muted">
          {data.clients.filter((item) => item.active).length} active clients ·{' '}
          {data.jobs.filter((item) => item.active).length} active jobs
        </p>
        <div className="admin-actions">
          <button className="button gold" disabled={busy || !data.fyiConfigured} onClick={sync}>
            {busy ? 'Working...' : 'Sync FYI now'}
          </button>
          <label className="button secondary file-button">
            Import CSV
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void importCsv(e.target.files?.[0])}
            />
          </label>
        </div>
        {!data.fyiConfigured && (
          <div className="message warning">
            Configure FYI_ACCESS_ID, FYI_ACCESS_SECRET and FYI_APPLICATION_ID to enable API sync.
            CSV import is available now.
          </div>
        )}
        {data.latestSync?.errorMessage && (
          <div className="message error">{data.latestSync.errorMessage}</div>
        )}
        {message && (
          <div
            className={`message ${message.toLowerCase().includes('fail') || message.toLowerCase().includes('unable') ? 'error' : 'success'}`}
          >
            {message}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Controlled list</p>
            <h2>Internal activities</h2>
          </div>
        </div>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (newActivity.trim()) void saveActivity(newActivity, true);
          }}
        >
          <input
            value={newActivity}
            onChange={(e) => setNewActivity(e.target.value)}
            placeholder="New activity"
            maxLength={120}
          />
          <button className="button primary">Add</button>
        </form>
        <div className="settings-list">
          {data.internalActivities.map((item) => (
            <label key={item.id}>
              <span>{item.name}</span>
              <input
                type="checkbox"
                checked={item.active}
                onChange={(e) => void saveActivity(item.name, e.target.checked, item.id)}
              />
            </label>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Entry exceptions</p>
            <h2>Needs attention</h2>
          </div>
          <span className="attention-count">{exceptions.length}</span>
        </div>
        {exceptions.length ? (
          <div className="exception-list">
            {exceptions.slice(0, 12).map(({ entry, reasons }) => (
              <div key={entry.id}>
                <strong>
                  {entry.userDisplayName} · {entry.clientName ?? entry.projectName}
                </strong>
                <span>
                  {reasons.join(', ')} · {formatDate(entry.startAt)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">No exceptions in the last 90 days.</div>
        )}
      </section>
      <section className="panel span-wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Per-job defaults</p>
            <h2>Billable settings</h2>
          </div>
        </div>
        <div className="job-settings">
          {data.jobs
            .filter((item) => item.active)
            .slice(0, 300)
            .map((job) => {
              const client = data.clients.find((item) => item.id === job.clientId);
              return (
                <label key={job.id}>
                  <span>
                    <strong>{client?.name}</strong>
                    {job.name}
                  </span>
                  <input
                    type="checkbox"
                    checked={job.defaultBillable}
                    onChange={(e) => void setDefault(job.id, e.target.checked)}
                  />
                </label>
              );
            })}
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [csrf, setCsrf] = useState('');
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [users, setUsers] = useState<SignedInUser[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setDashboard(await api('/api/dashboard'));
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load time.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    api<SessionData>('/api/session')
      .then((result) => {
        setCsrf(result.csrfToken);
        setUser(result.user);
      })
      .catch((caught) =>
        setError(
          caught instanceof Error ? caught.message : 'Microsoft sign-in could not be verified.',
        ),
      )
      .finally(() => setSessionLoading(false));
  }, []);
  useEffect(() => {
    if (user?.role === 'admin')
      api<{ users: SignedInUser[] }>('/api/users')
        .then((result) => setUsers(result.users))
        .catch(() => undefined);
  }, [user]);
  useEffect(() => {
    if (csrf) void refresh();
  }, [csrf, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  function openNew() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(entry: Entry) {
    setEditing(entry);
    setDialogOpen(true);
  }
  async function saveEntry(data: WorkPayload & { startLocal: string; endLocal: string }) {
    const path = editing ? `/api/entries/${editing.id}` : '/api/entries';
    await api(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(data) }, csrf);
    const edited = Boolean(editing);
    setDialogOpen(false);
    setEditing(null);
    setNotice(edited ? 'Entry updated.' : 'Time entry added.');
    await refresh();
    setVersion((value) => value + 1);
  }
  async function deleteEntry(entry: Entry) {
    if (
      !window.confirm(
        `Delete this ${entry.jobName ?? entry.activityName ?? entry.projectName} entry? This cannot be undone.`,
      )
    )
      return;
    try {
      await api(`/api/entries/${entry.id}`, { method: 'DELETE' }, csrf);
      setNotice('Entry deleted.');
      await refresh();
      setVersion((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to delete entry.');
    }
  }
  if (sessionLoading)
    return (
      <main className="splash">
        <img src="/brand/va-mark.png" alt="" />
        <p>Loading Timekeeper...</p>
      </main>
    );
  if (!csrf || !user)
    return (
      <main className="login-shell">
        <section className="login-card">
          <img src="/brand/va-logo.png" alt="Versatile Accounting" />
          <p className="eyebrow">Private workspace</p>
          <h1>Microsoft sign-in required</h1>
          <p className="muted">
            Timekeeper is available to Versatile Accounting Microsoft accounts.
          </p>
          {error && <div className="message error">{error}</div>}
          <button className="button gold full" onClick={() => window.location.reload()}>
            Sign in with Microsoft
          </button>
        </section>
      </main>
    );
  const views: View[] =
    user.role === 'admin'
      ? ['dashboard', 'history', 'reports', 'practice']
      : ['dashboard', 'history'];
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src="/brand/va-logo.png" alt="Versatile Accounting" />
          <div>
            <strong>Timekeeper</strong>
            <span>Australia / Brisbane</span>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {views.map((item) => (
            <button
              key={item}
              className={view === item ? 'selected' : ''}
              onClick={() => setView(item)}
            >
              {item === 'practice' ? 'Practice admin' : item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <span className="signed-in-user">{user.displayName}</span>
          <button className="button primary compact" onClick={openNew}>
            + Add time
          </button>
          <a className="link-button" href="/cdn-cgi/access/logout">
            Log out
          </a>
        </div>
      </header>
      <main className="content">
        {notice && (
          <div className="toast success" role="status">
            {notice}
          </div>
        )}
        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}
        {loading && !dashboard ? (
          <div className="loading">Loading your time...</div>
        ) : (
          dashboard &&
          (view === 'dashboard' ? (
            <Dashboard
              data={dashboard}
              csrf={csrf}
              refresh={refresh}
              now={now}
              editEntry={openEdit}
              deleteEntry={deleteEntry}
            />
          ) : view === 'history' ? (
            <History
              catalog={dashboard.catalog}
              user={user}
              users={users}
              refreshKey={version}
              editEntry={openEdit}
              deleteEntry={deleteEntry}
            />
          ) : view === 'reports' ? (
            <Reports csrf={csrf} />
          ) : (
            <Practice csrf={csrf} />
          ))
        )}
      </main>
      {dialogOpen && dashboard && (
        <EntryDialog
          entry={editing}
          catalog={dashboard.catalog}
          onClose={() => setDialogOpen(false)}
          onSave={saveEntry}
        />
      )}
    </div>
  );
}
