import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, downloadReport } from './api';
import {
  formatDate,
  formatDuration,
  formatTime,
  localDate,
  toBrisbaneLocalInput,
  todayBrisbane,
} from './format';
import type { DashboardData, Entry, HistoryData, Project } from './types';

type View = 'dashboard' | 'history' | 'reports';

function Login({ onLogin }: { onLogin: (csrf: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await api<{ csrfToken: string }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setPassword('');
      onLogin(result.csrfToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark" aria-hidden="true">
          T
        </div>
        <p className="eyebrow">Private workspace</p>
        <h1>Timekeeper</h1>
        <p className="muted">Enter the shared password to access time records and reports.</p>
        <form onSubmit={submit}>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            required
          />
          {error && (
            <div className="message error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

function EntryRows({
  entries,
  now,
  onEdit,
  onDelete,
}: {
  entries: Entry[];
  now: number;
  onEdit?: (entry: Entry) => void;
  onDelete?: (entry: Entry) => void;
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
              <strong>{entry.projectName}</strong>
              <span className="time-range">
                {formatTime(entry.startAt)} – {entry.endAt ? formatTime(entry.endAt) : 'Running'}
              </span>
              {entry.notes && <p>{entry.notes}</p>}
            </div>
            <div className="entry-side">
              <strong>{formatDuration(elapsed)}</strong>
              {entry.endAt && onEdit && onDelete && (
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
  projects,
  onClose,
  onSave,
}: {
  entry: Entry | null;
  projects: Project[];
  onClose: () => void;
  onSave: (data: {
    projectName: string;
    notes: string;
    startLocal: string;
    endLocal: string;
  }) => Promise<void>;
}) {
  const current = new Date();
  const oneHourAgo = new Date(current.getTime() - 3_600_000);
  const [projectName, setProjectName] = useState(entry?.projectName ?? '');
  const [notes, setNotes] = useState(entry?.notes ?? '');
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
      await onSave({ projectName, notes, startLocal, endLocal });
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
        <form onSubmit={submit} className="form-grid">
          <label className="span-2">
            Project / activity
            <input
              list="dialog-projects"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              maxLength={120}
              required
            />
            <datalist id="dialog-projects">
              {projects.map((project) => (
                <option value={project.name} key={project.id} />
              ))}
            </datalist>
          </label>
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
          <label className="span-2">
            Notes <span className="optional">Optional</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={2000}
              rows={4}
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
              {saving ? 'Saving…' : 'Save entry'}
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
  const [projectName, setProjectName] = useState('');
  const [notes, setNotes] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function clockIn(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setError('');
    setSuccess('');
    try {
      await api(
        '/api/clock-in',
        { method: 'POST', body: JSON.stringify({ projectName, notes }) },
        csrf,
      );
      setNotes('');
      await refresh();
      setSuccess('Clocked in successfully.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to clock in.');
    } finally {
      setWorking(false);
    }
  }
  async function clockOut() {
    setWorking(true);
    setError('');
    setSuccess('');
    try {
      await api('/api/clock-out', { method: 'POST' }, csrf);
      await refresh();
      setSuccess('Clocked out successfully.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to clock out.');
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
              <p className="eyebrow">{data.active.projectName}</p>
              <div className="timer-digits">{formatDuration(activeMs)}</div>
              <p className="muted">
                Started {formatTime(data.active.startAt)} on {formatDate(data.active.startAt)}
              </p>
              {data.active.notes && <p className="active-notes">{data.active.notes}</p>}
            </div>
            <button className="button stop large" onClick={clockOut} disabled={working}>
              {working ? 'Stopping…' : 'Clock out'}
            </button>
          </div>
        ) : (
          <form onSubmit={clockIn} className="clock-form">
            <label>
              Project / activity
              <input
                list="projects"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="Choose or enter a new activity"
                required
                maxLength={120}
              />
              <datalist id="projects">
                {data.projects.map((project) => (
                  <option value={project.name} key={project.id} />
                ))}
              </datalist>
            </label>
            <label>
              Notes <span className="optional">Optional</span>
              <input
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="What are you working on?"
                maxLength={2000}
              />
            </label>
            <button className="button start large" disabled={working}>
              {working ? 'Starting…' : 'Clock in'}
            </button>
          </form>
        )}
        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}
        {success && (
          <div className="message success" role="status">
            {success}
          </div>
        )}
      </section>

      <div className="summary-grid">
        <section className="metric-card">
          <p>Today</p>
          <strong>{formatDuration(data.today.totalMs)}</strong>
          <span>
            {data.today.entries.length} {data.today.entries.length === 1 ? 'entry' : 'entries'}
          </span>
        </section>
        <section className="metric-card">
          <p>This week</p>
          <strong>{formatDuration(data.week.totalMs)}</strong>
          <span>
            {formatDate(data.week.start)} – {formatDate(data.week.end)}
          </span>
        </section>
      </div>

      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{formatDate(data.today.date)}</p>
              <h2>Today’s entries</h2>
            </div>
            <span className="total-pill">{formatDuration(data.today.totalMs)}</span>
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
              <h2>Weekly totals</h2>
            </div>
          </div>
          {data.week.projectTotals.length ? (
            <div className="totals-list">
              {data.week.projectTotals.map((item) => (
                <div key={item.projectName}>
                  <span>{item.projectName}</span>
                  <strong>{formatDuration(item.totalMs)}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">No time recorded this week.</div>
          )}
        </section>
      </div>
    </>
  );
}

function History({
  projects,
  csrf,
  refreshKey,
  editEntry,
  deleteEntry,
}: {
  projects: Project[];
  csrf: string;
  refreshKey: number;
  editEntry: (entry: Entry) => void;
  deleteEntry: (entry: Entry) => void;
}) {
  const today = todayBrisbane();
  const initial = new Date(`${today}T00:00:00+10:00`);
  initial.setDate(initial.getDate() - 29);
  const [from, setFrom] = useState(localDate(initial.toISOString()));
  const [to, setTo] = useState(today);
  const [projectId, setProjectId] = useState('');
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ from, to });
      if (projectId) query.set('projectId', projectId);
      setData(await api<HistoryData>(`/api/entries?${query}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load history.');
    } finally {
      setLoading(false);
    }
  }, [from, to, projectId]);
  useEffect(() => {
    void load();
  }, [load, csrf, refreshKey]);
  const groups = useMemo(() => {
    const grouped = new Map<string, Entry[]>();
    for (const entry of data?.entries ?? []) {
      const date = localDate(entry.startAt);
      grouped.set(date, [...(grouped.get(date) ?? []), entry]);
    }
    return grouped;
  }, [data]);
  return (
    <section className="panel history-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Search and correct records</p>
          <h2>History</h2>
        </div>
        {data && <span className="total-pill">{formatDuration(data.totalMs)}</span>}
      </div>
      <div className="filters">
        <label>
          From
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <label>
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="message error">{error}</div>}
      {loading ? (
        <div className="loading">Loading history…</div>
      ) : groups.size ? (
        [...groups.entries()].map(([date, entries]) => (
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
            />
          </div>
        ))
      ) : (
        <div className="empty large-empty">
          <strong>No matching entries</strong>
          <span>Try a wider date range or another project.</span>
        </div>
      )}
      {data && data.projectTotals.length > 0 && (
        <div className="history-summary">
          <h3>Project totals for this range</h3>
          <div className="totals-list">
            {data.projectTotals.map((item) => (
              <div key={item.projectName}>
                <span>{item.projectName}</span>
                <strong>{formatDuration(item.totalMs)}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Reports() {
  const [week, setWeek] = useState(todayBrisbane());
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState('');
  async function download() {
    setDownloading(true);
    setMessage('');
    try {
      await downloadReport(week);
      setMessage('Excel report downloaded successfully.');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Unable to download the report.');
    } finally {
      setDownloading(false);
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
            A print-ready workbook with daily entries, daily totals, project totals, and the
            complete weekly total.
          </p>
        </div>
      </div>
      <div className="report-controls">
        <label>
          Choose any date in the week
          <input type="date" value={week} onChange={(event) => setWeek(event.target.value)} />
        </label>
        <button className="button primary" onClick={download} disabled={downloading}>
          {downloading ? 'Preparing workbook…' : 'Download .xlsx'}
        </button>
      </div>
      {message && (
        <div className={`message ${message.includes('success') ? 'success' : 'error'}`}>
          {message}
        </div>
      )}
      <div className="report-details">
        <div>
          <strong>Brisbane time</strong>
          <span>All clock times are converted from UTC.</span>
        </div>
        <div>
          <strong>Cross-midnight accuracy</strong>
          <span>Entries are allocated to each applicable date.</span>
        </div>
        <div>
          <strong>Excel-ready</strong>
          <span>Formatted headings, widths, totals, and print settings.</span>
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const [sessionLoading, setSessionLoading] = useState(true);
  const [csrf, setCsrf] = useState('');
  const [view, setView] = useState<View>('dashboard');
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [now, setNow] = useState(Date.now());
  const [dataVersion, setDataVersion] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setPageError('');
    try {
      setDashboard(await api<DashboardData>('/api/dashboard'));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) setCsrf('');
      else setPageError(caught instanceof Error ? caught.message : 'Unable to load the dashboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api<{ authenticated: boolean; csrfToken?: string }>('/api/session')
      .then((result) => {
        if (result.authenticated && result.csrfToken) setCsrf(result.csrfToken);
      })
      .finally(() => setSessionLoading(false));
  }, []);
  useEffect(() => {
    if (csrf) void refresh();
  }, [csrf, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function logout() {
    await api('/api/logout', { method: 'POST' }, csrf).catch(() => undefined);
    setCsrf('');
    setDashboard(null);
  }
  function openNew() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(entry: Entry) {
    setEditing(entry);
    setDialogOpen(true);
  }
  async function saveEntry(data: {
    projectName: string;
    notes: string;
    startLocal: string;
    endLocal: string;
  }) {
    const path = editing ? `/api/entries/${editing.id}` : '/api/entries';
    await api(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(data) }, csrf);
    setDialogOpen(false);
    setEditing(null);
    setNotice(editing ? 'Entry updated.' : 'Time entry added.');
    await refresh();
    setDataVersion((value) => value + 1);
  }
  async function deleteEntry(entry: Entry) {
    if (
      !window.confirm(
        `Delete the ${entry.projectName} entry from ${formatDate(entry.startAt)}? This cannot be undone.`,
      )
    )
      return;
    try {
      await api(`/api/entries/${entry.id}`, { method: 'DELETE' }, csrf);
      setNotice('Entry deleted.');
      await refresh();
      setDataVersion((value) => value + 1);
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : 'Unable to delete the entry.');
    }
  }

  if (sessionLoading)
    return (
      <main className="splash">
        <div className="brand-mark">T</div>
        <p>Loading Timekeeper…</p>
      </main>
    );
  if (!csrf) return <Login onLogin={setCsrf} />;
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark small">T</div>
          <div>
            <strong>Timekeeper</strong>
            <span>Australia / Brisbane</span>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {(['dashboard', 'history', 'reports'] as View[]).map((item) => (
            <button
              key={item}
              className={view === item ? 'selected' : ''}
              onClick={() => setView(item)}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <button className="button secondary compact" onClick={openNew}>
            + Add time
          </button>
          <button className="link-button" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <main className="content">
        {notice && (
          <div className="toast success" role="status">
            {notice}
          </div>
        )}
        {pageError && (
          <div className="message error" role="alert">
            {pageError}
          </div>
        )}
        {loading && !dashboard ? (
          <div className="loading page-loading">Loading your time…</div>
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
              projects={dashboard.projects}
              csrf={csrf}
              refreshKey={dataVersion}
              editEntry={openEdit}
              deleteEntry={deleteEntry}
            />
          ) : (
            <Reports />
          ))
        )}
      </main>
      {dialogOpen && (
        <EntryDialog
          entry={editing}
          projects={dashboard?.projects ?? []}
          onClose={() => setDialogOpen(false)}
          onSave={saveEntry}
        />
      )}
    </div>
  );
}
