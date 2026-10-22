import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  api,
  downloadClientReport,
  downloadClosedReport,
  downloadFinalizedReport,
  downloadReport,
  projectAction,
  projectsRoutes,
} from './api';
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
  BillingReviewData,
  BillingReviewItem,
  Client,
  ClosedReportSummary,
  ClosePreview,
  DashboardData,
  Entry,
  FinalizedReportSummary,
  HistoryData,
  ManualEntryPayload,
  PracticeData,
  PriorityAssignee,
  PriorityItem,
  ScheduleOccurrence,
  ScheduleRecurrence,
  ScheduleTemplate,
  SessionData,
  SignedInUser,
  WorkPayload,
  XeroProjectsSetupData,
  XeroWorkOptions,
} from './types';

type View =
  | 'dashboard'
  | 'history'
  | 'priorities'
  | 'schedule'
  | 'reports'
  | 'billing'
  | 'projects'
  | 'practice';
type WorkForm = {
  workType: 'client' | 'internal';
  clientId: string;
  jobId: string;
  internalActivityId: string;
  xeroProjectId: string;
  xeroTaskId: string;
  billable: boolean;
  clientDescription: string;
  internalNote: string;
};

// Exported for focused presentation-contract tests alongside the app component.
// eslint-disable-next-line react-refresh/only-export-components
export function formatBrisbaneDateTime(value: string): string {
  const formatted = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
  return `${formatted} Brisbane`;
}

// eslint-disable-next-line react-refresh/only-export-components
export function archivedEmailStatusLabel(status: FinalizedReportSummary['emailStatus']): string {
  switch (status) {
    case 'pending':
      return 'Queued';
    case 'sending':
      return 'Sending to provider';
    case 'sent':
      return 'Provider accepted';
    case 'failed':
      return 'Failed';
  }
}
function emptyWork(catalog?: Catalog): WorkForm {
  const recentJob = catalog?.jobs.find(
    (job) => job.id === localStorage.getItem('timekeeper:last-job'),
  );
  return {
    workType: 'client',
    clientId: recentJob?.clientId ?? '',
    jobId: recentJob?.id ?? '',
    internalActivityId: catalog?.internalActivities[0]?.id ?? '',
    xeroProjectId: '',
    xeroTaskId: '',
    billable: recentJob?.defaultBillable ?? true,
    clientDescription: '',
    internalNote: '',
  };
}
function payload(value: WorkForm): WorkPayload {
  return value.workType === 'client'
    ? {
        workType: 'client',
        clientId: value.clientId,
        ...(value.jobId ? { jobId: value.jobId } : {}),
        ...(value.xeroProjectId ? { xeroProjectId: value.xeroProjectId } : {}),
        ...(value.xeroTaskId ? { xeroTaskId: value.xeroTaskId } : {}),
        billable: value.billable,
        clientDescription: value.clientDescription,
        internalNote: value.internalNote,
        notes: value.internalNote,
      }
    : {
        workType: 'internal',
        internalActivityId: value.internalActivityId,
        billable: false,
        clientDescription: '',
        internalNote: value.internalNote,
        notes: value.internalNote,
      };
}
function formFromEntry(entry: Entry | null, catalog: Catalog): WorkForm {
  if (entry?.workType === 'client')
    return {
      workType: 'client',
      clientId: entry.clientId ?? '',
      jobId: entry.jobId ?? '',
      internalActivityId: catalog.internalActivities[0]?.id ?? '',
      xeroProjectId: entry.xeroProjectId ?? '',
      xeroTaskId: entry.xeroTaskId ?? '',
      billable: entry.billable,
      clientDescription: entry.clientDescription ?? '',
      internalNote: entry.internalNote ?? entry.notes,
    };
  return {
    workType: 'internal',
    clientId: '',
    jobId: '',
    internalActivityId: entry?.internalActivityId ?? catalog.internalActivities[0]?.id ?? '',
    xeroProjectId: '',
    xeroTaskId: '',
    billable: false,
    clientDescription: '',
    internalNote: entry?.internalNote ?? entry?.notes ?? '',
  };
}

function WorkFields({
  value,
  onChange,
  catalog,
  compact = false,
  staffName,
}: {
  value: WorkForm;
  onChange: (value: WorkForm) => void;
  catalog: Catalog;
  compact?: boolean;
  staffName?: string;
}) {
  const [clientSearch, setClientSearch] = useState('');
  const [matchedClients, setMatchedClients] = useState(catalog.clients);
  const [xeroOptions, setXeroOptions] = useState<XeroWorkOptions | null>(null);
  const [xeroLoading, setXeroLoading] = useState(false);
  const [xeroError, setXeroError] = useState('');
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
  useEffect(() => {
    if (value.workType !== 'client' || !value.clientId) {
      setXeroOptions(null);
      setXeroError('');
      return;
    }
    const controller = new AbortController();
    const query = new URLSearchParams({ clientId: value.clientId });
    if (value.jobId) query.set('jobId', value.jobId);
    setXeroLoading(true);
    setXeroError('');
    api<XeroWorkOptions>(`${projectsRoutes.workOptions}?${query}`, {
      signal: controller.signal,
    })
      .then(setXeroOptions)
      .catch((caught) => {
        if (!controller.signal.aborted)
          setXeroError(
            caught instanceof Error ? caught.message : 'Xero Projects options are unavailable.',
          );
      })
      .finally(() => !controller.signal.aborted && setXeroLoading(false));
    return () => controller.abort();
  }, [value.clientId, value.jobId, value.workType]);
  useEffect(() => {
    if (
      value.workType === 'client' &&
      !value.xeroProjectId &&
      !value.xeroTaskId &&
      xeroOptions?.suggestedProjectId &&
      xeroOptions.suggestedTaskId
    ) {
      onChange({
        ...value,
        xeroProjectId: xeroOptions.suggestedProjectId,
        xeroTaskId: xeroOptions.suggestedTaskId,
      });
    }
  }, [onChange, value, xeroOptions]);
  const clients = useMemo(() => matchedClients, [matchedClients]);
  const jobs = useMemo(
    () => catalog.jobs.filter((job) => job.clientId === value.clientId),
    [catalog.jobs, value.clientId],
  );
  const chooseClient = (clientId: string) =>
    onChange({
      ...value,
      clientId,
      jobId: '',
      xeroProjectId: '',
      xeroTaskId: '',
      billable: true,
    });
  const chooseJob = (jobId: string) => {
    const job = catalog.jobs.find((item) => item.id === jobId);
    onChange({
      ...value,
      jobId,
      xeroProjectId: '',
      xeroTaskId: '',
      billable: job?.defaultBillable ?? true,
    });
    if (jobId) localStorage.setItem('timekeeper:last-job', jobId);
  };
  const xeroTasks = (xeroOptions?.tasks ?? []).filter(
    (task) => !value.xeroProjectId || task.projectId === value.xeroProjectId,
  );
  const selectedTask = xeroTasks.find((task) => task.id === value.xeroTaskId);
  const taskRate = selectedTask?.rate;
  const formattedRate =
    taskRate === null || taskRate === undefined
      ? null
      : new Intl.NumberFormat('en-AU', {
          style: 'currency',
          currency: selectedTask?.currencyCode ?? 'AUD',
        }).format(taskRate);
  return (
    <div className={`work-fields ${compact ? 'compact-fields' : ''}`}>
      {staffName && (
        <label className="staff-field">
          Staff
          <output className="readonly-field">{staffName}</output>
        </label>
      )}
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
            Project / job <span>Local time classification</span>
            <select
              value={value.jobId}
              onChange={(event) => chooseJob(event.target.value)}
              disabled={!value.clientId}
            >
              <option value="">
                {value.clientId ? 'No project / activity yet' : 'Choose a client first'}
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
                No active FYI jobs are available. You can clock time now and classify it later.
              </small>
            )}
          </label>
          <label>
            Xero project <span>Required before upload</span>
            <select
              value={value.xeroProjectId}
              onChange={(event) =>
                onChange({
                  ...value,
                  xeroProjectId: event.target.value,
                  xeroTaskId: '',
                })
              }
              disabled={xeroLoading || !value.clientId || !xeroOptions?.connected}
            >
              <option value="">
                {xeroLoading
                  ? 'Loading Xero projects...'
                  : xeroOptions?.connected
                    ? 'Not mapped yet'
                    : 'Xero is not connected'}
              </option>
              {(xeroOptions?.projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Xero task / activity <span>Required before upload</span>
            <select
              value={value.xeroTaskId}
              onChange={(event) => onChange({ ...value, xeroTaskId: event.target.value })}
              disabled={!value.xeroProjectId || xeroLoading}
            >
              <option value="">
                {value.xeroProjectId ? 'Choose task / activity' : 'Choose Xero project first'}
              </option>
              {xeroTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.name} · {task.chargeType.replaceAll('_', ' ').toLowerCase()}
                </option>
              ))}
            </select>
            {selectedTask && (
              <small className="field-help neutral-help">
                {selectedTask.chargeType.replaceAll('_', ' ')}
                {formattedRate ? ` · ${formattedRate}` : ' · no hourly rate supplied'}
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
          {xeroError && (
            <small className="xero-field-message" role="status">
              Xero mapping could not be loaded. Time can still be saved locally. {xeroError}
            </small>
          )}
          {!xeroError && xeroOptions?.message && (
            <small className="xero-field-message" role="status">
              {xeroOptions.message}
            </small>
          )}
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
      {value.workType === 'client' && (
        <label className="description-field">
          Client-facing description <span>Sent to Xero after review</span>
          <textarea
            value={value.clientDescription}
            onChange={(event) => onChange({ ...value, clientDescription: event.target.value })}
            maxLength={2000}
            rows={compact ? 2 : 3}
            placeholder="Describe the completed work for the client"
          />
        </label>
      )}
      <label className="notes-field">
        Internal note <span>Practice-only · never sent to Xero</span>
        <textarea
          value={value.internalNote}
          onChange={(event) => onChange({ ...value, internalNote: event.target.value })}
          maxLength={2000}
          rows={compact ? 2 : 3}
          placeholder="Optional private context for the practice"
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
  canDelete = canEdit,
}: {
  entries: Entry[];
  now: number;
  onEdit?: (entry: Entry) => void;
  onDelete?: (entry: Entry) => void;
  canEdit?: (entry: Entry) => boolean;
  canDelete?: (entry: Entry) => boolean;
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
                <span>
                  {entry.jobName ??
                    entry.activityName ??
                    (entry.workType === 'client'
                      ? 'Unassigned project / activity'
                      : entry.projectName)}
                </span>
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
                {entry.lockedAt && <span className="tag locked">Locked</span>}
              </div>
              {entry.clientDescription && (
                <p className="client-description">
                  <span>Client description</span> {entry.clientDescription}
                </p>
              )}
              {(entry.internalNote ?? entry.notes) && (
                <p className="internal-note">
                  <span>Internal</span> {entry.internalNote ?? entry.notes}
                </p>
              )}
            </div>
            <div className="entry-side">
              <strong>{formatDuration(elapsed)}</strong>
              {entry.endAt && ((onEdit && canEdit(entry)) || (onDelete && canDelete(entry))) && (
                <div className="row-actions">
                  {onEdit && canEdit(entry) && (
                    <button className="link-button" onClick={() => onEdit(entry)}>
                      {entry.lockedAt ? 'Correct' : 'Edit'}
                    </button>
                  )}
                  {onDelete && canDelete(entry) && (
                    <button className="link-button danger-text" onClick={() => onDelete(entry)}>
                      Delete
                    </button>
                  )}
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
  user,
  onClose,
  onSave,
}: {
  entry: Entry | null;
  catalog: Catalog;
  user: SignedInUser;
  onClose: () => void;
  onSave: (data: WorkPayload & ManualEntryPayload) => Promise<void>;
}) {
  const current = new Date();
  const oneHourAgo = new Date(current.getTime() - 3_600_000);
  const initialStart = toBrisbaneLocalInput(entry?.startAt ?? oneHourAgo.toISOString());
  const initialDurationMinutes = entry?.endAt
    ? Math.max(1, Math.round((Date.parse(entry.endAt) - Date.parse(entry.startAt)) / 60_000))
    : 60;
  const initialExactDurationMs = entry?.endAt
    ? Date.parse(entry.endAt) - Date.parse(entry.startAt)
    : 60 * 60_000;
  const [work, setWork] = useState(() => formFromEntry(entry, catalog));
  const [workDate, setWorkDate] = useState(initialStart.slice(0, 10));
  const [startTime, setStartTime] = useState(initialStart.slice(11, 16));
  const [hours, setHours] = useState(Math.floor(initialDurationMinutes / 60));
  const [minutes, setMinutes] = useState(initialDurationMinutes % 60);
  const [startEdited, setStartEdited] = useState(false);
  const [durationEdited, setDurationEdited] = useState(false);
  const [correctionReason, setCorrectionReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const durationMinutes = hours * 60 + minutes;
    if (!workDate || !startTime) {
      setError('Enter the actual Brisbane work date and start time.');
      return;
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
      setError('Duration must be at least one minute.');
      return;
    }
    if (minutes < 0 || minutes > 59 || hours < 0) {
      setError('Use whole hours and 0 to 59 minutes.');
      return;
    }
    if (entry?.lockedAt && !correctionReason.trim()) {
      setError('A reason is required for a correction to locked time.');
      return;
    }
    const editedStartLocal = `${workDate}T${startTime}`;
    const startLocal = entry && !startEdited ? entry.startAt : editedStartLocal;
    const startInstant = new Date(
      entry && !startEdited ? entry.startAt : `${editedStartLocal}:00+10:00`,
    );
    const end = new Date(startInstant);
    if (Number.isNaN(end.getTime())) {
      setError('The work date or start time is invalid.');
      return;
    }
    end.setTime(
      end.getTime() +
        (entry && !durationEdited ? initialExactDurationMs : durationMinutes * 60_000),
    );
    const endLocal = entry && !startEdited && !durationEdited ? entry.endAt! : end.toISOString();
    setSaving(true);
    try {
      await onSave({
        ...payload(work),
        workDate,
        startTime,
        durationMinutes,
        startLocal,
        endLocal,
        ...(entry?.lockedAt
          ? { correctionReason: correctionReason.trim(), expectedRevision: entry.revision ?? 1 }
          : {}),
      });
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
        {entry?.lockedAt && (
          <div className="message warning">
            This time is in a closed period. Saving creates an audited correction and revised
            report; the original version remains in the history.
          </div>
        )}
        <form onSubmit={submit} className="form-grid">
          <div className="span-2">
            <WorkFields
              value={work}
              onChange={setWork}
              catalog={catalog}
              staffName={entry?.userDisplayName ?? user.displayName}
            />
          </div>
          <label>
            Actual work date <span className="timezone">Brisbane</span>
            <input
              type="date"
              value={workDate}
              onChange={(event) => {
                setWorkDate(event.target.value);
                setStartEdited(true);
              }}
              required
            />
          </label>
          <label>
            Actual start time <span className="timezone">Brisbane</span>
            <input
              type="time"
              value={startTime}
              onChange={(event) => {
                setStartTime(event.target.value);
                setStartEdited(true);
              }}
              required
            />
          </label>
          <fieldset className="duration-fields span-2">
            <legend>Actual duration</legend>
            <label>
              Hours
              <input
                type="number"
                min="0"
                max="999"
                step="1"
                inputMode="numeric"
                value={hours}
                onChange={(event) => {
                  setHours(Number(event.target.value));
                  setDurationEdited(true);
                }}
                required
              />
            </label>
            <label>
              Minutes
              <input
                type="number"
                min="0"
                max="59"
                step="1"
                inputMode="numeric"
                value={minutes}
                onChange={(event) => {
                  setMinutes(Number(event.target.value));
                  setDurationEdited(true);
                }}
                required
              />
            </label>
          </fieldset>
          {entry && (
            <p className="muted span-2">
              The saved seconds and exact duration are preserved unless you edit the start or
              duration fields.
            </p>
          )}
          {entry?.lockedAt && (
            <label className="span-2">
              Correction reason
              <textarea
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Explain why this closed entry must change"
                required
              />
            </label>
          )}
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
  user,
  csrf,
  refresh,
  now,
  editEntry,
  deleteEntry,
}: {
  data: DashboardData;
  user: SignedInUser;
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
      const result = await api<{ xeroWarning?: string | null }>(
        '/api/clock-in',
        { method: 'POST', body: JSON.stringify(payload(work)) },
        csrf,
      );
      setWork((value) => ({ ...value, clientDescription: '', internalNote: '' }));
      await refresh();
      setMessage({
        kind: result.xeroWarning ? 'error' : 'success',
        text: result.xeroWarning
          ? `Clocked in locally, but the Xero selection needs attention: ${result.xeroWarning}`
          : 'Clocked in successfully.',
      });
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
              <h1>
                {data.active.jobName ??
                  data.active.activityName ??
                  (data.active.workType === 'client'
                    ? 'Unassigned project / activity'
                    : data.active.projectName)}
              </h1>
              <div className="timer-digits">{formatDuration(activeMs)}</div>
              <p className="muted">
                Started {formatTime(data.active.startAt)} on {formatDate(data.active.startAt)}
              </p>
              {data.active.clientDescription && (
                <p className="active-notes">{data.active.clientDescription}</p>
              )}
              {(data.active.internalNote ?? data.active.notes) && (
                <p className="active-internal-note">
                  Internal: {data.active.internalNote ?? data.active.notes}
                </p>
              )}
            </div>
            <button className="button attention large" onClick={clockOut} disabled={working}>
              {working ? 'Stopping...' : 'Clock out'}
            </button>
          </div>
        ) : data.catalog.clients.length || data.catalog.internalActivities.length ? (
          <form onSubmit={clockIn} className="clock-form">
            <WorkFields
              value={work}
              onChange={setWork}
              catalog={data.catalog}
              compact
              staffName={user.displayName}
            />
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
            canEdit={(entry) => !entry.lockedAt || user.role === 'admin'}
            canDelete={(entry) => !entry.lockedAt}
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
              canEdit={(entry) =>
                entry.lockedAt ? user.role === 'admin' : entry.userId === user.id
              }
              canDelete={(entry) => !entry.lockedAt && entry.userId === user.id}
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

const PRIORITY_PEOPLE: { id: PriorityAssignee; name: string }[] = [
  { id: 'alex', name: 'Alex' },
  { id: 'brendon', name: 'Brendon' },
  { id: 'suzie', name: 'Suzie' },
];

function Priorities({ csrf }: { csrf: string }) {
  const [items, setItems] = useState<PriorityItem[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState<PriorityAssignee>('alex');
  const [priority, setPriority] = useState(5);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ items: PriorityItem[] }>('/api/priorities');
      setItems(result.items);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load priorities.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setSavingId('new');
    setError('');
    try {
      const result = await api<{ item: PriorityItem }>(
        '/api/priorities',
        {
          method: 'POST',
          body: JSON.stringify({ title, description, assignee, priority }),
        },
        csrf,
      );
      setItems((current) => [...current, result.item]);
      setTitle('');
      setDescription('');
      setPriority(5);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to add the priority.');
    } finally {
      setSavingId('');
    }
  }

  async function update(item: PriorityItem, changes: Partial<PriorityItem>) {
    setSavingId(item.id);
    setError('');
    try {
      const next = { ...item, ...changes };
      const result = await api<{ item: PriorityItem }>(
        `/api/priorities/${item.id}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            title: next.title,
            description: next.description,
            assignee: next.assignee,
            priority: next.priority,
            completed: next.completed,
          }),
        },
        csrf,
      );
      setItems((current) =>
        current.map((candidate) => (candidate.id === item.id ? result.item : candidate)),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to update the priority.');
    } finally {
      setSavingId('');
    }
  }

  async function remove(item: PriorityItem) {
    if (!window.confirm(`Remove “${item.title}”? This cannot be undone.`)) return;
    setSavingId(item.id);
    setError('');
    try {
      await api(`/api/priorities/${item.id}`, { method: 'DELETE' }, csrf);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to remove the priority.');
    } finally {
      setSavingId('');
    }
  }

  const active = items.filter((item) => !item.completed);
  const completed = items.filter((item) => item.completed);
  const sorted = (values: PriorityItem[]) =>
    [...values].sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="priorities-page">
      <section className="panel priority-hero">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Shared focus list</p>
            <h2>Team priorities</h2>
            <p className="muted">Keep Alex, Brendon and Suzie aligned on what matters next.</p>
          </div>
          <div className="priority-total">
            <strong>{active.length}</strong>
            <span>active</span>
          </div>
        </div>
        <form className="priority-form" onSubmit={add}>
          <label className="priority-title-input">
            Title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={240}
              required
              placeholder="Short priority title"
            />
          </label>
          <label className="priority-description-input">
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2000}
              placeholder="Add the details, desired outcome or next step"
              rows={2}
            />
          </label>
          <label>
            For
            <select
              value={assignee}
              onChange={(event) => setAssignee(event.target.value as PriorityAssignee)}
            >
              {PRIORITY_PEOPLE.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
              {Array.from({ length: 10 }, (_, index) => 10 - index).map((value) => (
                <option key={value} value={value}>
                  {value}
                  {value === 10 ? ' — Highest' : value === 1 ? ' — Lowest' : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="button gold" disabled={savingId === 'new'}>
            {savingId === 'new' ? 'Adding...' : 'Add priority'}
          </button>
        </form>
        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}
      </section>

      {loading ? (
        <div className="loading">Loading team priorities...</div>
      ) : (
        <div className="priority-board">
          {PRIORITY_PEOPLE.map((person) => {
            const personItems = sorted(active.filter((item) => item.assignee === person.id));
            return (
              <section className="priority-column" key={person.id}>
                <div className="priority-column-heading">
                  <div className="person-initial">{person.name[0]}</div>
                  <div>
                    <h3>{person.name}</h3>
                    <span>{personItems.length} active</span>
                  </div>
                </div>
                <div className="priority-list">
                  {personItems.length ? (
                    personItems.map((item) => (
                      <article
                        className={`priority-card priority-${item.priority >= 8 ? 'high' : item.priority >= 5 ? 'medium' : 'standard'}`}
                        key={item.id}
                      >
                        <div className="priority-card-top">
                          <span className="priority-score" aria-label={`Priority ${item.priority}`}>
                            {item.priority}
                          </span>
                          <button
                            className="link-button danger-text"
                            onClick={() => void remove(item)}
                            disabled={savingId === item.id}
                          >
                            Remove
                          </button>
                        </div>
                        <h4>{item.title}</h4>
                        {item.description && <p>{item.description}</p>}
                        <div className="priority-controls">
                          <label>
                            For
                            <select
                              aria-label={`Assignee for ${item.title}`}
                              value={item.assignee}
                              disabled={savingId === item.id}
                              onChange={(event) =>
                                void update(item, {
                                  assignee: event.target.value as PriorityAssignee,
                                })
                              }
                            >
                              {PRIORITY_PEOPLE.map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Priority
                            <select
                              aria-label={`Priority for ${item.title}`}
                              value={item.priority}
                              disabled={savingId === item.id}
                              onChange={(event) =>
                                void update(item, { priority: Number(event.target.value) })
                              }
                            >
                              {Array.from({ length: 10 }, (_, index) => 10 - index).map((value) => (
                                <option key={value} value={value}>
                                  {value}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <label className="complete-control">
                          <input
                            type="checkbox"
                            checked={item.completed}
                            disabled={savingId === item.id}
                            onChange={(event) =>
                              void update(item, { completed: event.target.checked })
                            }
                          />
                          Mark complete
                        </label>
                      </article>
                    ))
                  ) : (
                    <div className="empty priority-empty">No active priorities.</div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {!loading && completed.length > 0 && (
        <section className="panel completed-priorities">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Recently finished</p>
              <h2>Completed</h2>
            </div>
            <span className="total-rule">{completed.length} items</span>
          </div>
          <div className="completed-list">
            {sorted(completed).map((item) => (
              <article key={item.id}>
                <label className="complete-control">
                  <input
                    type="checkbox"
                    checked
                    disabled={savingId === item.id}
                    onChange={(event) => void update(item, { completed: event.target.checked })}
                  />
                  <span>
                    <strong>{item.title}</strong>
                    {item.description && <span>{item.description}</span>}
                    {PRIORITY_PEOPLE.find((person) => person.id === item.assignee)?.name} · Priority{' '}
                    {item.priority}
                  </span>
                </label>
                <button
                  className="link-button danger-text"
                  onClick={() => void remove(item)}
                  disabled={savingId === item.id}
                >
                  Remove
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const WEEKDAYS = [
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
  ['Sun', 7],
] as const;
const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const mondayOf = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  return addDays(value, 1 - day);
};

function Schedule({ csrf }: { csrf: string }) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayBrisbane()));
  const [templates, setTemplates] = useState<ScheduleTemplate[]>([]);
  const [occurrences, setOccurrences] = useState<ScheduleOccurrence[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<'all' | PriorityAssignee>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'completed'>('all');
  const [editingId, setEditingId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const emptyForm = () => ({
    title: '',
    description: '',
    assignee: 'suzie' as PriorityAssignee,
    recurrenceType: 'weekly' as ScheduleRecurrence,
    weekdays: [1] as number[],
    startDate: todayBrisbane(),
    monthlyDay: 1,
    yearlyMonth: 1,
    yearlyDay: 1,
    dueTime: '',
  });
  const [form, setForm] = useState(emptyForm);
  const load = useCallback(async () => {
    try {
      const result = await api<{
        templates: ScheduleTemplate[];
        occurrences: ScheduleOccurrence[];
      }>(`/api/schedule?weekStart=${weekStart}`);
      setTemplates(result.templates);
      setOccurrences(result.occurrences);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load the schedule.');
    }
  }, [weekStart]);
  useEffect(() => {
    void load();
  }, [load]);
  const payload = () => ({
    ...form,
    dueTime: form.dueTime || null,
    monthlyDay: form.recurrenceType === 'monthly' ? form.monthlyDay : null,
    yearlyMonth: form.recurrenceType === 'yearly' ? form.yearlyMonth : null,
    yearlyDay: form.recurrenceType === 'yearly' ? form.yearlyDay : null,
    weekdays: ['weekly', 'fortnightly'].includes(form.recurrenceType) ? form.weekdays : [],
  });
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api(
        editingId ? `/api/schedule/templates/${editingId}` : '/api/schedule/templates',
        { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload()) },
        csrf,
      );
      setForm(emptyForm());
      setEditingId('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save the schedule.');
    } finally {
      setSaving(false);
    }
  }
  function edit(item: ScheduleTemplate) {
    setEditingId(item.id);
    setForm({
      title: item.title,
      description: item.description,
      assignee: item.assignee,
      recurrenceType: item.recurrenceType,
      weekdays: item.weekdays,
      startDate: item.startDate,
      monthlyDay: item.monthlyDay ?? 1,
      yearlyMonth: item.yearlyMonth ?? 1,
      yearlyDay: item.yearlyDay ?? 1,
      dueTime: item.dueTime ?? '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function archive(item: ScheduleTemplate) {
    if (!confirm(`Archive “${item.title}”?`)) return;
    await api(`/api/schedule/templates/${item.id}`, { method: 'DELETE' }, csrf);
    await load();
  }
  async function complete(item: ScheduleOccurrence, completed: boolean) {
    await api(
      `/api/schedule/occurrences/${item.id}`,
      { method: 'PUT', body: JSON.stringify({ completed }) },
      csrf,
    );
    await load();
  }
  const visible = occurrences.filter(
    (item) =>
      (assigneeFilter === 'all' || item.assignee === assigneeFilter) &&
      (statusFilter === 'all' || (statusFilter === 'completed' ? item.completed : !item.completed)),
  );
  const overdue = visible.filter((item) => item.overdue);
  const week = visible.filter(
    (item) => item.dueDate >= weekStart && item.dueDate <= addDays(weekStart, 6) && !item.overdue,
  );
  const card = (item: ScheduleOccurrence) => (
    <article
      className={`schedule-card ${item.overdue ? 'overdue' : ''} ${item.completed ? 'complete' : ''}`}
      key={item.id}
    >
      <label>
        <input
          type="checkbox"
          checked={item.completed}
          onChange={(event) => void complete(item, event.target.checked)}
        />
        <span>
          <strong>{item.title}</strong>
          {item.description && <small>{item.description}</small>}
          <small>
            {PRIORITY_PEOPLE.find((p) => p.id === item.assignee)?.name} · {item.recurrenceLabel}
            {item.dueTime
              ? ` · ${new Date(item.dueAt).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit' })}`
              : ''}
          </small>
        </span>
      </label>
    </article>
  );
  return (
    <div className="schedule-page">
      <section className="panel schedule-hero">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Regular work</p>
            <h2>Schedule</h2>
            <p className="muted">Weekly, fortnightly, monthly and yearly obligations.</p>
          </div>
        </div>
        <form className="schedule-form" onSubmit={save}>
          <label>
            Title
            <input
              required
              maxLength={240}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <label className="wide">
            Description
            <textarea
              rows={2}
              maxLength={2000}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label>
            For
            <select
              value={form.assignee}
              onChange={(e) => setForm({ ...form, assignee: e.target.value as PriorityAssignee })}
            >
              {PRIORITY_PEOPLE.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Repeats
            <select
              value={form.recurrenceType}
              onChange={(e) =>
                setForm({ ...form, recurrenceType: e.target.value as ScheduleRecurrence })
              }
            >
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>
          {['weekly', 'fortnightly'].includes(form.recurrenceType) && (
            <fieldset className="weekday-picker">
              <legend>Days</legend>
              {WEEKDAYS.map(([name, value]) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={form.weekdays.includes(value)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        weekdays: e.target.checked
                          ? [...form.weekdays, value]
                          : form.weekdays.filter((day) => day !== value),
                      })
                    }
                  />
                  {name}
                </label>
              ))}
            </fieldset>
          )}
          {form.recurrenceType === 'monthly' && (
            <label>
              Day of month
              <input
                type="number"
                min="1"
                max="31"
                value={form.monthlyDay}
                onChange={(e) => setForm({ ...form, monthlyDay: Number(e.target.value) })}
              />
            </label>
          )}
          {form.recurrenceType === 'yearly' && (
            <>
              <label>
                Month
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={form.yearlyMonth}
                  onChange={(e) => setForm({ ...form, yearlyMonth: Number(e.target.value) })}
                />
              </label>
              <label>
                Day
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={form.yearlyDay}
                  onChange={(e) => setForm({ ...form, yearlyDay: Number(e.target.value) })}
                />
              </label>
            </>
          )}
          <label>
            Starts
            <input
              type="date"
              required
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          </label>
          <label>
            Due time (optional)
            <input
              type="time"
              value={form.dueTime}
              onChange={(e) => setForm({ ...form, dueTime: e.target.value })}
            />
          </label>
          <div className="schedule-actions">
            <button className="button gold" disabled={saving}>
              {editingId ? 'Save changes' : 'Add schedule'}
            </button>
            {editingId && (
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setEditingId('');
                  setForm(emptyForm());
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
        {error && <div className="message error">{error}</div>}
      </section>
      <section className="panel schedule-controls">
        <div>
          <button className="button secondary" onClick={() => setWeekStart(addDays(weekStart, -7))}>
            ← Previous
          </button>
          <button
            className="button secondary"
            onClick={() => setWeekStart(mondayOf(todayBrisbane()))}
          >
            This week
          </button>
          <button className="button secondary" onClick={() => setWeekStart(addDays(weekStart, 7))}>
            Next →
          </button>
        </div>
        <strong>
          {formatDate(weekStart)} – {formatDate(addDays(weekStart, 6))}
        </strong>
        <div>
          <select
            aria-label="Filter assignee"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value as typeof assigneeFilter)}
          >
            <option value="all">Everyone</option>
            {PRIORITY_PEOPLE.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="completed">Completed</option>
          </select>
        </div>
      </section>
      {overdue.length > 0 && (
        <section className="panel overdue-panel">
          <h2>Overdue</h2>
          <div className="schedule-list">{overdue.map(card)}</div>
        </section>
      )}
      <div className="schedule-week">
        {WEEKDAYS.map(([name], index) => {
          const day = addDays(weekStart, index);
          const items = week.filter((item) => item.dueDate === day);
          return (
            <section className="panel schedule-day" key={day}>
              <h3>
                {name}
                <span>{formatDate(day)}</span>
              </h3>
              {items.length ? (
                <div className="schedule-list">{items.map(card)}</div>
              ) : (
                <p className="muted">No scheduled work.</p>
              )}
            </section>
          );
        })}
      </div>
      <section className="panel schedule-templates">
        <h2>Active schedules</h2>
        {templates.map((item) => (
          <article key={item.id}>
            <div>
              <strong>{item.title}</strong>
              <span>
                {PRIORITY_PEOPLE.find((p) => p.id === item.assignee)?.name} · {item.recurrenceType}
              </span>
            </div>
            <div>
              <button className="link-button" onClick={() => edit(item)}>
                Edit
              </button>
              <button className="link-button danger-text" onClick={() => void archive(item)}>
                Archive
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

function AdminClose({ csrf }: { csrf: string }) {
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function loadPreview() {
    setBusy(true);
    setMessage('');
    try {
      setPreview(await projectAction<ClosePreview>('/api/close/preview', csrf));
      setConfirmation('');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Unable to preview the close.');
    } finally {
      setBusy(false);
    }
  }
  async function closeNow() {
    if (!preview || !reason.trim() || confirmation !== preview.confirmationPhrase) return;
    setBusy(true);
    setMessage('');
    try {
      await projectAction('/api/close', csrf, {
        cutoff: preview.cutoff,
        reason: reason.trim(),
        previewHash: preview.previewHash,
        confirmation,
      });
      setMessage('The period was closed and durable report deliveries were queued.');
      setPreview(null);
      setReason('');
      setConfirmation('');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Unable to close the period.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admin-close">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Administrator action</p>
          <h3>Close now and queue detailed reports</h3>
          <p className="muted">
            Preview the exact Brisbane cutoff, coverage and recipients before creating an immutable
            report version.
          </p>
        </div>
        {!preview && (
          <button className="button secondary" disabled={busy} onClick={() => void loadPreview()}>
            {busy ? 'Preparing...' : 'Preview close'}
          </button>
        )}
      </div>
      {preview && (
        <div className="close-preview">
          <dl>
            <div>
              <dt>Coverage</dt>
              <dd>
                {formatBrisbaneDateTime(preview.periodStart)} to{' '}
                {formatBrisbaneDateTime(preview.periodEnd)}
              </dd>
            </div>
            <div>
              <dt>Cutoff</dt>
              <dd>{formatBrisbaneDateTime(preview.cutoff)}</dd>
            </div>
            <div>
              <dt>Entries</dt>
              <dd>{preview.entryCount}</dd>
            </div>
            <div>
              <dt>Splits</dt>
              <dd>
                {preview.runningTimersToSplit} running · {preview.completedEntriesToSplit} completed
              </dd>
            </div>
            <div>
              <dt>Recipients</dt>
              <dd>{preview.recipients.join(', ') || 'No recipients configured'}</dd>
            </div>
          </dl>
          {preview.activationBaseline && (
            <div className="activation-baseline">
              <p className="eyebrow">Initial activation baseline</p>
              <strong>
                {formatBrisbaneDateTime(preview.activationBaseline.periodStart)} to{' '}
                {formatBrisbaneDateTime(preview.activationBaseline.periodEnd)}
              </strong>
              <span>
                {preview.activationBaseline.entryCount} entries ·{' '}
                {formatDuration(preview.activationBaseline.totalMs)} ·{' '}
                {preview.activationBaseline.runningTimersToSplit} running timers ·{' '}
                {preview.activationBaseline.completedEntriesToSplit} completed-entry splits
              </span>
              <span>
                Historical report email is{' '}
                {preview.activationBaseline.historicalEmailSuppressed
                  ? 'suppressed for this baseline.'
                  : 'not suppressed.'}
              </span>
            </div>
          )}
          {preview.warnings.map((warning) => (
            <div className="message warning" key={warning}>
              {warning}
            </div>
          ))}
          <label>
            Reason for this manual close
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={500}
              required
            />
          </label>
          <label className="span-2">
            Type this exact confirmation after reviewing the cutoff, counts and recipients
            <code className="confirmation-phrase">{preview.confirmationPhrase}</code>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          <div className="admin-actions">
            <button className="button secondary" onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </button>
            <button
              className="button attention"
              onClick={() => void closeNow()}
              disabled={
                busy ||
                !reason.trim() ||
                confirmation !== preview.confirmationPhrase ||
                !preview.recipients.length
              }
            >
              {busy ? 'Closing...' : 'Close and queue reports'}
            </button>
          </div>
        </div>
      )}
      {message && (
        <div className={`message ${message.startsWith('The period') ? 'success' : 'error'}`}>
          {message}
        </div>
      )}
    </div>
  );
}

function Reports({
  csrf,
  canSendTest,
  canClose,
}: {
  csrf: string;
  canSendTest: boolean;
  canClose: boolean;
}) {
  const [week, setWeek] = useState(todayBrisbane());
  const today = todayBrisbane();
  const [clientId, setClientId] = useState('');
  const [clientFrom, setClientFrom] = useState(`${today.slice(0, 8)}01`);
  const [clientTo, setClientTo] = useState(today);
  const [clients, setClients] = useState<Client[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [finalizedReports, setFinalizedReports] = useState<FinalizedReportSummary[]>([]);
  const [closedReports, setClosedReports] = useState<ClosedReportSummary[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(true);
  useEffect(() => {
    api<{ clients: Client[] }>('/api/catalog')
      .then((result) => setClients(result.clients))
      .catch((caught) =>
        setMessage(caught instanceof Error ? caught.message : 'Unable to load clients.'),
      );
    api<{ reports: FinalizedReportSummary[] }>('/api/reports/finalized')
      .then((result) => setFinalizedReports(result.reports))
      .catch((caught) =>
        setMessage(caught instanceof Error ? caught.message : 'Unable to load previous reports.'),
      )
      .finally(() => setArchiveLoading(false));
    api<{ reports: ClosedReportSummary[] }>('/api/reports/closed')
      .then((result) => setClosedReports(result.reports))
      .catch((caught) =>
        setMessage(
          caught instanceof Error ? caught.message : 'Unable to load closed-period reports.',
        ),
      );
  }, []);
  async function downloadClientPdf() {
    if (!clientId) {
      setMessage('Unable to prepare the PDF: choose a client first.');
      return;
    }
    setBusy('client-pdf');
    setMessage('');
    try {
      await downloadClientReport(clientId, clientFrom, clientTo);
      setMessage('Client PDF report downloaded successfully.');
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'PDF report download failed.';
      setMessage(`Unable to download client PDF: ${detail}`);
    } finally {
      setBusy('');
    }
  }
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
  async function downloadFinalized(report: FinalizedReportSummary) {
    setBusy(`archive:${report.weekStart}`);
    setMessage('');
    try {
      await downloadFinalizedReport(report.weekStart);
      setMessage(`Finalized report for ${report.weekStart} downloaded.`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Unable to download finalized report.');
    } finally {
      setBusy('');
    }
  }
  async function downloadClosed(report: ClosedReportSummary, format: 'pdf' | 'csv' | 'xlsx') {
    setBusy(`closed:${report.id}:${format}`);
    setMessage('');
    try {
      await downloadClosedReport(report.id, format);
      setMessage(`Closed-period report ${report.id} version ${report.version} downloaded.`);
    } catch (caught) {
      setMessage(
        caught instanceof Error ? caught.message : 'Unable to download closed-period report.',
      );
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
          {canSendTest && (
            <button className="button secondary" onClick={send} disabled={Boolean(busy)}>
              {busy === 'send' ? 'Sending...' : 'Send test email'}
            </button>
          )}
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
      <div className="client-report-section">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Client-facing document</p>
            <h3>Client detailed time PDF</h3>
            <p className="muted">
              Completed billable time only, with staff names, work descriptions and totals.
            </p>
          </div>
          <span className="pdf-rule">PDF</span>
        </div>
        <div className="client-report-controls">
          <label>
            Client
            <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <option value="">Choose a client</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input
              type="date"
              value={clientFrom}
              max={clientTo}
              onChange={(event) => setClientFrom(event.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={clientTo}
              min={clientFrom}
              onChange={(event) => setClientTo(event.target.value)}
            />
          </label>
          <button
            className="button gold"
            onClick={() => void downloadClientPdf()}
            disabled={Boolean(busy) || !clientId || !clientFrom || !clientTo}
          >
            {busy === 'client-pdf' ? 'Preparing PDF...' : 'Download client PDF'}
          </button>
        </div>
      </div>
      <div className="report-archive">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Friday 20:00 Brisbane close</p>
            <h3>Immutable confidential reports</h3>
            <p className="muted">
              Saved PDF, CSV and Excel copies are generated from the same snapshot. “Accepted” means
              the email provider accepted a copy; it is not proof of inbox delivery.
            </p>
          </div>
          <span className="total-rule">{closedReports.length} versions</span>
        </div>
        {closedReports.length ? (
          <div className="report-archive-list">
            {closedReports.map((report) => (
              <article key={report.id}>
                <div>
                  <strong>
                    {formatDate(report.coverageFrom)} to {formatDate(report.cutoffAt)} · version{' '}
                    {report.version}
                  </strong>
                  <span>
                    {report.entryCount} entries · {formatDuration(report.totalMs)}
                  </span>
                  <span className="delivery-state-summary">
                    {report.delivery.queued} queued · {report.delivery.providerAccepted} provider
                    accepted · {report.delivery.failed} failed · {report.delivery.needsAttention}{' '}
                    need attention · {report.delivery.total} total
                  </span>
                  <span>
                    Report ID {report.id} · {report.correctionReason}
                  </span>
                </div>
                <div className="report-buttons">
                  {(['pdf', 'csv', 'xlsx'] as const).map((format) => (
                    <button
                      key={format}
                      className="button secondary"
                      disabled={Boolean(busy)}
                      onClick={() => void downloadClosed(report, format)}
                    >
                      {busy === `closed:${report.id}:${format}`
                        ? 'Downloading...'
                        : format.toUpperCase()}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">No Friday close report has been created yet.</div>
        )}
      </div>
      <div className="report-archive">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Archived calendar-week reports</p>
            <h3>Previous finalized exports</h3>
            <p className="muted">
              “Provider accepted” confirms hand-off to the email provider; it does not prove inbox
              delivery.
            </p>
          </div>
          <span className="total-rule">{finalizedReports.length} reports</span>
        </div>
        {archiveLoading ? (
          <div className="loading">Loading previous reports...</div>
        ) : finalizedReports.length ? (
          <div className="report-archive-list">
            {finalizedReports.map((report) => (
              <article key={report.weekStart}>
                <div>
                  <strong>
                    {report.weekStart} to {report.weekEnd}
                  </strong>
                  <span>
                    Finalized {formatBrisbaneDateTime(report.finalizedAt)} · {report.entryCount}{' '}
                    entries · Email: {archivedEmailStatusLabel(report.emailStatus)}
                  </span>
                </div>
                <button
                  className="button secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void downloadFinalized(report)}
                >
                  {busy === `archive:${report.weekStart}`
                    ? 'Downloading...'
                    : 'Download final .xlsx'}
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">No weeks have been finalized yet.</div>
        )}
      </div>
      {canClose && <AdminClose csrf={csrf} />}
    </section>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function reviewStatusLabel(item: BillingReviewItem): string {
  if (item.syncState === 'needs_attention') return 'Needs attention';
  if (item.syncState === 'failed') return 'Upload failed';
  if (item.syncState === 'accepted') return 'Sent to Xero';
  if (item.syncState === 'sending') return 'Sending to Xero';
  if (item.syncState === 'queued') return 'Queued for Xero';
  if (item.reviewState === 'approved') return 'Approved';
  if (item.reviewState === 'blocked') return 'Blocked';
  if (item.reviewState === 'cancelled') return 'Cancelled';
  return 'Ready for review';
}

// eslint-disable-next-line react-refresh/only-export-components
export function mergeBillingReviewPage(
  current: BillingReviewData | null,
  result: BillingReviewData,
  request: {
    append: boolean;
    queryKey: string;
    acceptedQueryKey: string;
    expectedPage: number;
  },
): BillingReviewData | null {
  if (!request.append) return result;
  if (
    !current ||
    request.queryKey !== request.acceptedQueryKey ||
    request.expectedPage !== current.page + 1 ||
    result.page !== request.expectedPage
  ) {
    return current;
  }
  const existing = new Set(current.items.map((item) => item.entryId));
  return {
    ...result,
    items: [...current.items, ...result.items.filter((item) => !existing.has(item.entryId))],
  };
}

function billingStatusLabel(item: BillingReviewItem): string {
  switch (item.billingState) {
    case 'invoiced':
      return 'Invoiced in Xero';
    case 'not_invoiced':
      return 'Not invoiced in Xero';
    case 'unknown':
      return 'Xero billing state unknown';
    default:
      return 'Not yet recorded in Xero';
  }
}

function BillingReview({ csrf, isAdmin }: { csrf: string; isAdmin: boolean }) {
  const [data, setData] = useState<BillingReviewData | null>(null);
  const [selected, setSelected] = useState<BillingReviewItem | null>(null);
  const [state, setState] = useState('');
  const [search, setSearch] = useState('');
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const loadGeneration = useRef(0);
  const acceptedQueryKey = useRef('');
  const load = useCallback(
    async (page = 1, append = false) => {
      const generation = ++loadGeneration.current;
      const queryKey = JSON.stringify([state, search.trim()]);
      setLoading(true);
      setError('');
      try {
        const query = new URLSearchParams();
        if (state) query.set('state', state);
        if (search.trim()) query.set('search', search.trim());
        query.set('page', String(page));
        query.set('pageSize', '50');
        const result = await api<BillingReviewData>(`${projectsRoutes.review}?${query}`);
        if (generation !== loadGeneration.current) return;
        if (result.page !== page) {
          setError('The review list returned an unexpected page. Refresh the list and try again.');
          return;
        }
        const previousQueryKey = acceptedQueryKey.current;
        if (!append) acceptedQueryKey.current = queryKey;
        setData((current) =>
          mergeBillingReviewPage(current, result, {
            append,
            queryKey,
            acceptedQueryKey: previousQueryKey,
            expectedPage: page,
          }),
        );
      } catch (caught) {
        if (generation !== loadGeneration.current) return;
        setError(caught instanceof Error ? caught.message : 'Unable to load reviewed time.');
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    },
    [search, state],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function openPreview(entryId: string) {
    setBusy(`preview:${entryId}`);
    setError('');
    try {
      const preview = await api<BillingReviewItem>(
        `${projectsRoutes.review}/${encodeURIComponent(entryId)}/preview`,
      );
      setSelected(preview);
      setAcknowledged([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to prepare the review preview.');
    } finally {
      setBusy('');
    }
  }
  async function approve() {
    if (!selected) return;
    setBusy('approve');
    setError('');
    try {
      await projectAction(
        `${projectsRoutes.review}/${encodeURIComponent(selected.entryId)}/approve`,
        csrf,
        {
          entryRevision: selected.entryRevision,
          mappingRevision: selected.mappingRevision,
          expectedPreviewHash: selected.previewHash,
          acknowledgedWarnings: acknowledged,
        },
      );
      setSelected(null);
      setMessage('The exact reviewed payload was approved and queued safely.');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to approve this entry.');
    } finally {
      setBusy('');
    }
  }
  async function cancelApproval() {
    if (!selected?.approvalId) return;
    const reason = window.prompt(
      'Why should this no-write approval be cancelled and returned for a fresh review?',
    );
    if (!reason?.trim()) return;
    setBusy('cancel');
    try {
      await projectAction(
        `${projectsRoutes.review}/approvals/${encodeURIComponent(selected.approvalId)}/cancel`,
        csrf,
        { reason: reason.trim() },
      );
      setSelected(null);
      setMessage('The no-write approval was cancelled and returned for a fresh review.');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to cancel the approval.');
    } finally {
      setBusy('');
    }
  }
  async function reconcileNotFound() {
    if (!selected?.outboxId) return;
    if (
      !window.confirm(
        'Confirm you checked Xero Projects and no matching time entry exists. The same immutable payload will be queued again.',
      )
    )
      return;
    setBusy('reconcile');
    setError('');
    try {
      await projectAction(
        `${projectsRoutes.outbox}/${encodeURIComponent(selected.outboxId)}/reconcile`,
        csrf,
        { outcome: 'not_found' },
      );
      setSelected(null);
      setMessage('The verified missing upload was safely re-queued.');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to reconcile this upload.');
    } finally {
      setBusy('');
    }
  }
  async function reconcileFound() {
    if (!selected?.outboxId) return;
    const remoteTimeEntryId = window.prompt(
      'Paste the exact Xero Projects time-entry ID. Timekeeper will fetch it and require an exact payload match.',
    );
    if (!remoteTimeEntryId?.trim()) return;
    setBusy('reconcile');
    setError('');
    try {
      await projectAction(
        `${projectsRoutes.outbox}/${encodeURIComponent(selected.outboxId)}/reconcile`,
        csrf,
        { outcome: 'found', remoteTimeEntryId: remoteTimeEntryId.trim() },
      );
      setSelected(null);
      setMessage('The exact matching Xero time entry was attached to the audit record.');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to reconcile this upload.');
    } finally {
      setBusy('');
    }
  }
  async function runAction<T>(
    path: string,
    key: string,
    success: string | ((result: T) => string),
  ) {
    setBusy(key);
    setError('');
    setMessage('');
    try {
      const result = await projectAction<T>(path, csrf);
      setMessage(typeof success === 'function' ? success(result) : success);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action could not be completed.');
    } finally {
      setBusy('');
    }
  }
  const requiredWarnings = selected?.warnings.filter((warning) => warning.requiresAcknowledgement);
  const canApprove = Boolean(
    selected &&
    selected.reviewState === 'eligible' &&
    !selected.blockers.length &&
    requiredWarnings?.every((warning) => acknowledged.includes(warning.code)),
  );
  return (
    <div className="billing-page">
      <section className="panel billing-hero">
        <div>
          <p className="eyebrow">Reviewed time to Xero Projects</p>
          <h2>Billing review</h2>
          <p className="muted">
            Approve the exact locked-time payload. Internal notes never appear here or in Xero.
          </p>
        </div>
        <div className="billing-connection">
          <span className={`status-dot ${data?.uploadsEnabled ? 'live' : ''}`} />
          <span>
            {data?.tenantName ?? 'Xero not connected'}
            <small>
              {!data?.uploadsEnabled
                ? 'Uploads disabled'
                : data.processingPaused
                  ? 'Processing paused'
                  : 'Processing available'}
            </small>
          </span>
        </div>
      </section>
      <section className="panel">
        <div className="review-toolbar">
          <label>
            Status
            <select value={state} onChange={(event) => setState(event.target.value)}>
              <option value="">All statuses</option>
              <option value="eligible">Ready for review</option>
              <option value="blocked">Blocked</option>
              <option value="approved">Approved</option>
              <option value="queued">Queued</option>
              <option value="sending">Sending to Xero</option>
              <option value="accepted">Sent to Xero</option>
              <option value="failed">Upload failed</option>
              <option value="needs_attention">Needs attention</option>
            </select>
          </label>
          <label>
            Find employee, client or project
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search reviewed time"
            />
          </label>
          <button className="button secondary" onClick={() => void load()} disabled={loading}>
            Refresh list
          </button>
          <button
            className="button secondary"
            onClick={() =>
              void runAction(
                projectsRoutes.billingRefresh,
                'billing',
                (result: { checked: number; failed: number }) =>
                  `Xero status refresh completed: ${result.checked} checked; ${result.failed} failed.`,
              )
            }
            disabled={Boolean(busy)}
          >
            {busy === 'billing' ? 'Refreshing...' : 'Refresh Xero status'}
          </button>
          {isAdmin && (
            <button
              className="button gold"
              onClick={() =>
                void runAction(
                  projectsRoutes.outboxProcess,
                  'outbox',
                  'Eligible queued uploads were handed to the durable processor.',
                )
              }
              disabled={Boolean(busy) || !data?.uploadsEnabled || data.processingPaused}
            >
              {busy === 'outbox' ? 'Processing...' : 'Process eligible queue'}
            </button>
          )}
        </div>
        {data?.lastStatusRefreshAt && (
          <p className="toolbar-note">
            Billing status last refreshed{' '}
            {new Date(data.lastStatusRefreshAt).toLocaleString('en-AU')}. “Invoiced” is a Xero
            Projects time status, not proof of authorisation or payment.
          </p>
        )}
        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}
        {message && (
          <div
            className={`message ${/^Xero status refresh completed: .*; [1-9]\d* failed\.$/.test(message) ? 'warning' : 'success'}`}
          >
            {message}
          </div>
        )}
        {loading ? (
          <div className="loading">Loading billing review...</div>
        ) : data?.items.length ? (
          <>
            <div className="review-list">
              {data.items.map((item) => (
                <article key={item.entryId}>
                  <div className="review-primary">
                    <div>
                      <strong>{item.clientName}</strong>
                      <span>
                        {item.projectName ?? 'Project mapping required'} ·{' '}
                        {item.taskName ?? 'Task mapping required'}
                      </span>
                    </div>
                    <span className={`review-state ${item.syncState} ${item.reviewState}`}>
                      {reviewStatusLabel(item)}
                    </span>
                  </div>
                  <div className="review-facts">
                    <span>{item.employeeName}</span>
                    <span>{formatDate(item.workDate)}</span>
                    <span>{formatDuration(item.actualDurationSeconds * 1000)} actual</span>
                    <span>{item.uploadDurationMinutes}m proposed</span>
                    <span>{item.billable ? 'Locally billable' : 'Locally non-billable'}</span>
                    <span>{item.chargeType?.replaceAll('_', ' ') ?? 'No charge type'}</span>
                    <span>{billingStatusLabel(item)}</span>
                    {item.remoteStatus && <span>Raw Xero status: {item.remoteStatus}</span>}
                    {item.remoteTimeEntryId && <span>Xero ID: {item.remoteTimeEntryId}</span>}
                    {item.statusCheckedAt && (
                      <span>
                        Status checked {new Date(item.statusCheckedAt).toLocaleString('en-AU')}
                      </span>
                    )}
                  </div>
                  <p>{item.clientDescription || 'No client-facing description provided.'}</p>
                  {item.blockers.length > 0 && (
                    <ul className="review-blockers">
                      {item.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  )}
                  {item.discrepancies.length > 0 && (
                    <ul className="review-blockers">
                      {item.discrepancies.map((discrepancy) => (
                        <li key={discrepancy}>{discrepancy}</li>
                      ))}
                    </ul>
                  )}
                  <button
                    className="button secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void openPreview(item.entryId)}
                  >
                    {busy === `preview:${item.entryId}` ? 'Opening...' : 'Review exact payload'}
                  </button>
                </article>
              ))}
            </div>
            <div className="review-pagination">
              <span>
                Showing {data.items.length} of {data.total} matching entries
              </span>
              {data.hasMore && (
                <button
                  className="button secondary"
                  disabled={loading}
                  onClick={() => void load(data.page + 1, true)}
                >
                  {loading ? 'Loading...' : 'Load more'}
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="empty large-empty">
            <strong>No matching reviewed time</strong>
            <span>Closed, eligible client time will appear here.</span>
          </div>
        )}
      </section>
      {selected && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}
        >
          <section className="modal review-modal" role="dialog" aria-modal="true">
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Exact proposed Xero payload</p>
                <h2>{selected.clientName}</h2>
              </div>
              <button className="icon-button" onClick={() => setSelected(null)} aria-label="Close">
                ×
              </button>
            </div>
            <dl className="payload-review">
              <div>
                <dt>Staff</dt>
                <dd>{selected.employeeName}</dd>
              </div>
              <div>
                <dt>Contact</dt>
                <dd>{selected.contactName ?? 'Not mapped'}</dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd>{selected.projectName ?? 'Not mapped'}</dd>
              </div>
              <div>
                <dt>Task / activity</dt>
                <dd>{selected.taskName ?? 'Not mapped'}</dd>
              </div>
              <div>
                <dt>Work date</dt>
                <dd>{formatDate(selected.workDate)}</dd>
              </div>
              <div>
                <dt>Actual duration</dt>
                <dd>{formatDuration(selected.actualDurationSeconds * 1000)}</dd>
              </div>
              <div>
                <dt>Xero duration</dt>
                <dd>{selected.uploadDurationMinutes} minutes</dd>
              </div>
              <div>
                <dt>Timekeeper classification</dt>
                <dd>{selected.billable ? 'Billable' : 'Non-billable'}</dd>
              </div>
              <div>
                <dt>Xero task charge</dt>
                <dd>
                  {selected.chargeType?.replaceAll('_', ' ') ?? 'Unavailable'}
                  {selected.rate !== null
                    ? ` · ${new Intl.NumberFormat('en-AU', {
                        style: 'currency',
                        currency: selected.currencyCode ?? 'AUD',
                      }).format(selected.rate)}`
                    : ''}
                </dd>
              </div>
              <div>
                <dt>Xero billing state</dt>
                <dd>{billingStatusLabel(selected)}</dd>
              </div>
              <div>
                <dt>Raw Xero status</dt>
                <dd>{selected.remoteStatus ?? 'Not available'}</dd>
              </div>
              <div>
                <dt>Remote time-entry ID</dt>
                <dd>{selected.remoteTimeEntryId ?? 'Not assigned'}</dd>
              </div>
              <div>
                <dt>Last status refresh</dt>
                <dd>
                  {selected.statusCheckedAt
                    ? new Date(selected.statusCheckedAt).toLocaleString('en-AU')
                    : 'Not refreshed'}
                </dd>
              </div>
              <div className="span-2">
                <dt>Client-facing description sent to Xero</dt>
                <dd>{selected.clientDescription || 'No description'}</dd>
              </div>
            </dl>
            {selected.blockers.map((blocker) => (
              <div className="message error" key={blocker}>
                {blocker}
              </div>
            ))}
            {selected.discrepancies.map((discrepancy) => (
              <div className="message warning" key={discrepancy}>
                <strong>Discrepancy:</strong> {discrepancy}
              </div>
            ))}
            {selected.warnings.map((warning) => (
              <label className="warning-ack" key={warning.code}>
                {warning.requiresAcknowledgement && (
                  <input
                    type="checkbox"
                    checked={acknowledged.includes(warning.code)}
                    onChange={(event) =>
                      setAcknowledged((current) =>
                        event.target.checked
                          ? [...current, warning.code]
                          : current.filter((code) => code !== warning.code),
                      )
                    }
                  />
                )}
                <span>
                  <strong>
                    {warning.requiresAcknowledgement ? 'Acknowledge warning' : 'Note'}
                  </strong>
                  {warning.message}
                </span>
              </label>
            ))}
            <div className="modal-actions">
              {selected.syncState === 'needs_attention' && selected.outboxId && (
                <>
                  <button
                    className="button secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void reconcileFound()}
                  >
                    Attach exact Xero entry
                  </button>
                  <button
                    className="button attention"
                    disabled={Boolean(busy)}
                    onClick={() => void reconcileNotFound()}
                  >
                    Verified missing — retry
                  </button>
                </>
              )}
              {selected.approvalId && selected.canReturnToReview && (
                <button
                  className="button attention"
                  disabled={Boolean(busy)}
                  onClick={() => void cancelApproval()}
                >
                  Return to review
                </button>
              )}
              <button className="button secondary" onClick={() => setSelected(null)}>
                Close
              </button>
              {selected.reviewState === 'eligible' && (
                <button
                  className="button gold"
                  disabled={!canApprove || Boolean(busy)}
                  onClick={() => void approve()}
                >
                  {busy === 'approve' ? 'Approving...' : 'Approve exact payload'}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function XeroProjectsSetup({ csrf }: { csrf: string }) {
  const [data, setData] = useState<XeroProjectsSetupData | null>(null);
  const [cutoverDate, setCutoverDate] = useState('');
  const [selectedTenant, setSelectedTenant] = useState('');
  const [tenantConfirmation, setTenantConfirmation] = useState('');
  const [clientDrafts, setClientDrafts] = useState<Record<string, string>>({});
  const [projectDrafts, setProjectDrafts] = useState<Record<string, string>>({});
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({});
  const [userDrafts, setUserDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    try {
      const result = await api<XeroProjectsSetupData>(projectsRoutes.setup);
      setData(result);
      setCutoverDate(result.cutoverDate ?? '');
      setSelectedTenant(result.availableOrganisations[0]?.tenantId ?? '');
      setTenantConfirmation('');
      setClientDrafts(
        Object.fromEntries(
          result.clientMappings.map((item) => [item.localId, item.xeroContactId ?? '']),
        ),
      );
      setProjectDrafts(
        Object.fromEntries(
          result.workMappings.map((item) => [item.localId, item.xeroProjectId ?? '']),
        ),
      );
      setTaskDrafts(
        Object.fromEntries(
          result.workMappings.map((item) => [item.localId, item.xeroTaskId ?? '']),
        ),
      );
      setUserDrafts(
        Object.fromEntries(
          result.userMappings.map((item) => [item.localId, item.xeroUserId ?? '']),
        ),
      );
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load Xero Projects setup.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function action(
    key: string,
    path: string,
    body: unknown,
    success: string,
    method: 'POST' | 'PUT' = 'POST',
  ) {
    setBusy(key);
    setError('');
    setMessage('');
    try {
      await projectAction(path, csrf, body, method);
      setMessage(success);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The setup action failed.');
    } finally {
      setBusy('');
    }
  }
  async function connect() {
    setBusy('connect');
    try {
      const result = await projectAction<{ authorisationUrl: string }>(
        projectsRoutes.oauthStart,
        csrf,
      );
      window.location.assign(result.authorisationUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to start secure Xero sign-in.');
      setBusy('');
    }
  }
  async function saveMapping(kind: 'client' | 'work' | 'user', localId: string) {
    let body: Record<string, unknown> =
      kind === 'client'
        ? { xeroContactId: clientDrafts[localId] || null }
        : kind === 'work'
          ? {
              xeroProjectId: projectDrafts[localId] || null,
              xeroTaskId: taskDrafts[localId] || null,
            }
          : { xeroUserId: userDrafts[localId] || null };
    if (kind === 'user' && userDrafts[localId]) {
      const local = data?.userMappings.find((item) => item.localId === localId);
      const remote = data?.userOptions.find((item) => item.id === userDrafts[localId]);
      const emailsDiffer = Boolean(
        local?.localEmail &&
        remote?.detail &&
        local.localEmail.toLowerCase() !== remote.detail.toLowerCase(),
      );
      if (
        emailsDiffer &&
        !window.confirm(
          `The Timekeeper email (${local!.localEmail}) differs from the Xero email (${remote!.detail}). Confirm that you verified these are the same person.`,
        )
      )
        return;
      body = {
        xeroUserId: userDrafts[localId],
        acknowledgeDifferentEmail: emailsDiffer,
      };
    }
    await action(
      `mapping:${kind}:${localId}`,
      `${projectsRoutes.mappings}/${kind}/${encodeURIComponent(localId)}`,
      body,
      'Mapping saved. Existing approvals were not silently changed.',
      'PUT',
    );
  }
  if (!data) return <div className="loading">Loading Xero Projects setup...</div>;
  return (
    <div className="projects-setup">
      <section className="panel setup-hero">
        <div>
          <p className="eyebrow">Administrator-only integration</p>
          <h2>Xero Projects setup</h2>
          <p className="muted">
            Connect the practice organisation once. Staff do not connect individual Xero accounts,
            and Timekeeper continues working while this integration is disabled.
          </p>
        </div>
        <div className="setup-state">
          <span className={`status-dot ${data.connectionStatus === 'connected' ? 'live' : ''}`} />
          <strong>{data.tenantName ?? 'Not connected'}</strong>
          <small>{data.tenantId ?? 'No tenant selected'}</small>
        </div>
      </section>
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {message && <div className="message success">{message}</div>}
      {data.lastError && <div className="message warning">{data.lastError}</div>}
      <div className="setup-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Connection</p>
              <h3>Practice organisation</h3>
            </div>
          </div>
          {!data.configured ? (
            <div className="message warning">
              Server-side Xero credentials and token encryption must be configured before an
              administrator can connect. Secrets are never entered in this screen.
            </div>
          ) : data.connectionStatus === 'disconnected' ? (
            <button className="button gold" disabled={Boolean(busy)} onClick={() => void connect()}>
              {busy === 'connect' ? 'Opening Xero...' : 'Connect Xero securely'}
            </button>
          ) : data.connectionStatus === 'select_tenant' ? (
            <div className="tenant-choice">
              <label>
                Confirm the Versatile Accounting organisation
                <select
                  value={selectedTenant}
                  onChange={(event) => {
                    setSelectedTenant(event.target.value);
                    setTenantConfirmation('');
                  }}
                >
                  <option value="">Choose organisation</option>
                  {data.availableOrganisations.map((tenant) => (
                    <option key={tenant.tenantId} value={tenant.tenantId}>
                      {tenant.tenantName} · {tenant.tenantId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Type the exact organisation name to confirm
                <input
                  value={tenantConfirmation}
                  onChange={(event) => setTenantConfirmation(event.target.value)}
                  autoComplete="off"
                  placeholder={
                    data.availableOrganisations.find((tenant) => tenant.tenantId === selectedTenant)
                      ?.tenantName ?? 'Organisation name'
                  }
                />
              </label>
              <button
                className="button gold"
                disabled={
                  !selectedTenant ||
                  tenantConfirmation !==
                    data.availableOrganisations.find((tenant) => tenant.tenantId === selectedTenant)
                      ?.tenantName ||
                  Boolean(busy)
                }
                onClick={() =>
                  void action(
                    'tenant',
                    projectsRoutes.organisation,
                    { tenantId: selectedTenant, confirmation: tenantConfirmation },
                    'The Xero organisation was confirmed.',
                  )
                }
              >
                Confirm organisation
              </button>
            </div>
          ) : (
            <div className="connection-actions">
              <div className="message success">
                Connected to {data.tenantName} ({data.tenantId}).
              </div>
              <button
                className="button secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  void action(
                    'pause',
                    projectsRoutes.pause,
                    { paused: !data.processingPaused },
                    data.processingPaused ? 'Processing resumed.' : 'Processing paused.',
                  )
                }
              >
                {data.processingPaused ? 'Resume processing' : 'Pause processing'}
              </button>
              <button
                className="link-button danger-text"
                disabled={Boolean(busy)}
                onClick={() => {
                  if (
                    window.confirm(
                      'Disconnect Xero Projects? Existing approved payloads and audit history remain tenant-bound.',
                    )
                  )
                    void action(
                      'disconnect',
                      projectsRoutes.disconnect,
                      { confirmation: true },
                      'Xero Projects was disconnected and processing paused.',
                    );
                }}
              >
                Disconnect
              </button>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Safety controls</p>
              <h3>Cutover and uploads</h3>
            </div>
          </div>
          <label>
            First eligible Brisbane work date
            <input
              type="date"
              value={cutoverDate}
              onChange={(event) => setCutoverDate(event.target.value)}
            />
          </label>
          <p className="muted small-copy">
            Earlier time remains reportable but cannot be uploaded. Changing this does not
            reinterpret an existing approval.
          </p>
          <label className="confirm-control">
            <input
              type="checkbox"
              checked={data.enabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                if (
                  enabled &&
                  !window.confirm(
                    'Enable Xero upload eligibility? Approved items still use the durable queue and all mappings must be valid.',
                  )
                )
                  return;
                void action(
                  'enabled',
                  projectsRoutes.setup,
                  { enabled, cutoverDate: cutoverDate || null },
                  enabled ? 'Xero eligibility enabled.' : 'Xero eligibility disabled.',
                  'PUT',
                );
              }}
            />
            Xero upload eligibility enabled
          </label>
          <button
            className="button secondary"
            disabled={Boolean(busy) || !cutoverDate}
            onClick={() =>
              void action(
                'cutover',
                projectsRoutes.setup,
                { enabled: data.enabled, cutoverDate },
                'Cutover date saved.',
                'PUT',
              )
            }
          >
            Save cutover date
          </button>
        </section>
        <section className="panel span-wide">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Read-only catalogue</p>
              <h3>Contacts, projects, tasks and users</h3>
            </div>
            <button
              className="button gold"
              disabled={Boolean(busy) || data.connectionStatus !== 'connected'}
              onClick={() =>
                void action(
                  'refresh',
                  projectsRoutes.refresh,
                  {},
                  'A complete Xero catalogue refresh finished.',
                )
              }
            >
              {busy === 'refresh' ? 'Refreshing...' : 'Refresh catalogue'}
            </button>
          </div>
          <div className="catalog-stats">
            <span>
              Contacts <strong>{data.catalogue.contacts}</strong>
            </span>
            <span>
              Projects <strong>{data.catalogue.projects}</strong>
            </span>
            <span>
              Tasks <strong>{data.catalogue.tasks}</strong>
            </span>
            <span>
              Users <strong>{data.catalogue.users}</strong>
            </span>
          </div>
          <p className="toolbar-note">
            {data.catalogue.complete ? 'Complete refresh' : 'Catalogue is incomplete'} ·{' '}
            {data.catalogue.refreshedAt
              ? new Date(data.catalogue.refreshedAt).toLocaleString('en-AU')
              : 'Never refreshed'}
          </p>
          {data.catalogue.error && <div className="message error">{data.catalogue.error}</div>}
        </section>
        <section className="panel span-wide mapping-section">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Explicit tenant-bound mappings</p>
              <h3>Clients to Xero contacts</h3>
            </div>
          </div>
          <div className="mapping-list">
            {data.clientMappings.map((mapping) => (
              <div className="mapping-row" key={mapping.localId}>
                <div>
                  <strong>{mapping.localName}</strong>
                  <span className={mapping.valid ? 'valid-text' : 'invalid-text'}>
                    {mapping.valid ? 'Valid mapping' : 'Required before upload'}
                  </span>
                </div>
                <label>
                  Xero contact
                  <select
                    value={clientDrafts[mapping.localId] ?? ''}
                    onChange={(event) =>
                      setClientDrafts((current) => ({
                        ...current,
                        [mapping.localId]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Not mapped</option>
                    {data.contactOptions.map((option) => (
                      <option key={option.id} value={option.id} disabled={!option.active}>
                        {option.name}
                        {option.detail ? ` · ${option.detail}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void saveMapping('client', mapping.localId)}
                >
                  Save
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="panel span-wide mapping-section">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Work mapping</p>
              <h3>Local jobs to Xero project and task</h3>
            </div>
          </div>
          <div className="mapping-list">
            {data.workMappings.map((mapping) => (
              <div className="mapping-row work-mapping-row" key={mapping.localId}>
                <div>
                  <strong>{mapping.localName}</strong>
                  <span>{mapping.clientName}</span>
                </div>
                <label>
                  Xero project
                  <select
                    value={projectDrafts[mapping.localId] ?? ''}
                    onChange={(event) => {
                      setProjectDrafts((current) => ({
                        ...current,
                        [mapping.localId]: event.target.value,
                      }));
                      setTaskDrafts((current) => ({ ...current, [mapping.localId]: '' }));
                    }}
                  >
                    <option value="">Not mapped</option>
                    {data.projectOptions.map((option) => (
                      <option key={option.id} value={option.id} disabled={!option.active}>
                        {option.name}
                        {option.detail ? ` · ${option.detail}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Xero task / activity
                  <select
                    value={taskDrafts[mapping.localId] ?? ''}
                    onChange={(event) =>
                      setTaskDrafts((current) => ({
                        ...current,
                        [mapping.localId]: event.target.value,
                      }))
                    }
                    disabled={!projectDrafts[mapping.localId]}
                  >
                    <option value="">Not mapped</option>
                    {data.taskOptions
                      .filter((option) => option.projectId === projectDrafts[mapping.localId])
                      .map((option) => (
                        <option key={option.id} value={option.id} disabled={!option.active}>
                          {option.name} · {option.chargeType.replaceAll('_', ' ')}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="button secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void saveMapping('work', mapping.localId)}
                >
                  Save
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="panel span-wide mapping-section">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Staff identity</p>
              <h3>Timekeeper staff to Xero Projects users</h3>
            </div>
          </div>
          <div className="mapping-list">
            {data.userMappings.map((mapping) => (
              <div className="mapping-row" key={mapping.localId}>
                <div>
                  <strong>{mapping.localName}</strong>
                  <span>{mapping.localEmail}</span>
                </div>
                <label>
                  Xero Projects user
                  <select
                    value={userDrafts[mapping.localId] ?? ''}
                    onChange={(event) =>
                      setUserDrafts((current) => ({
                        ...current,
                        [mapping.localId]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Not mapped</option>
                    {data.userOptions.map((option) => (
                      <option key={option.id} value={option.id} disabled={!option.active}>
                        {option.name}
                        {option.detail ? ` · ${option.detail}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void saveMapping('user', mapping.localId)}
                >
                  Save
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
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
            Configure the FYI access credentials to enable API sync. CSV import is available now.
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
  async function saveEntry(data: WorkPayload & ManualEntryPayload) {
    const lockedCorrection = Boolean(editing?.lockedAt);
    const path = lockedCorrection
      ? `/api/entries/${editing!.id}/corrections`
      : editing
        ? `/api/entries/${editing.id}`
        : '/api/entries';
    const result = await api<{ xeroWarning?: string | null }>(
      path,
      { method: lockedCorrection ? 'POST' : editing ? 'PUT' : 'POST', body: JSON.stringify(data) },
      csrf,
    );
    const edited = Boolean(editing);
    setDialogOpen(false);
    setEditing(null);
    setNotice(
      result.xeroWarning
        ? `${edited ? 'Entry updated' : 'Time entry added'} locally. Xero selection needs attention: ${result.xeroWarning}`
        : edited
          ? 'Entry updated.'
          : 'Time entry added.',
    );
    await refresh();
    setVersion((value) => value + 1);
  }
  async function deleteEntry(entry: Entry) {
    if (entry.lockedAt) {
      setError('Closed time cannot be deleted. Use the audited correction flow instead.');
      return;
    }
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
  const views: View[] = ['dashboard', 'history', 'priorities'];
  if (user.canManageSchedule) views.push('schedule');
  if (user.canViewReports) views.push('reports');
  if (user.canReviewBilling || user.role === 'admin') views.push('billing');
  if (user.role === 'admin') views.push('projects', 'practice');
  const viewLabels: Record<View, string> = {
    dashboard: 'Dashboard',
    history: 'History',
    priorities: 'Priorities',
    schedule: 'Schedule',
    reports: 'Reports',
    billing: 'Billing review',
    projects: 'Xero Projects',
    practice: 'Practice admin',
  };
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
              {viewLabels[item]}
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
              user={user}
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
            <Reports
              csrf={csrf}
              canSendTest={user.role === 'admin'}
              canClose={user.role === 'admin'}
            />
          ) : view === 'billing' ? (
            <BillingReview csrf={csrf} isAdmin={user.role === 'admin'} />
          ) : view === 'projects' ? (
            <XeroProjectsSetup csrf={csrf} />
          ) : view === 'priorities' ? (
            <Priorities csrf={csrf} />
          ) : view === 'schedule' ? (
            <Schedule csrf={csrf} />
          ) : (
            <Practice csrf={csrf} />
          ))
        )}
      </main>
      {dialogOpen && dashboard && (
        <EntryDialog
          entry={editing}
          catalog={dashboard.catalog}
          user={user}
          onClose={() => setDialogOpen(false)}
          onSave={saveEntry}
        />
      )}
    </div>
  );
}
