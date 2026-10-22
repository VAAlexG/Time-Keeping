export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}, csrf?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (csrf) headers.set('x-csrf-token', csrf);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: 'Request failed.' }))) as {
      error?: string;
    };
    throw new ApiError(body.error ?? 'Request failed.', response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/**
 * The reviewed-time feature is intentionally grouped under one route prefix. Keeping these
 * contracts here prevents the UI from scattering security-sensitive workflow URLs.
 */
export const projectsRoutes = {
  workOptions: '/api/projects/catalog',
  setup: '/api/projects/setup',
  oauthStart: '/api/projects/oauth/start',
  organisation: '/api/projects/organisation',
  refresh: '/api/projects/catalog/refresh',
  pause: '/api/projects/pause',
  disconnect: '/api/projects/disconnect',
  mappings: '/api/projects/mappings',
  review: '/api/projects/review',
  outbox: '/api/projects/outbox',
  outboxProcess: '/api/projects/outbox/process',
  billingRefresh: '/api/projects/billing/refresh',
} as const;

export async function projectAction<T>(
  path: string,
  csrf: string,
  body: unknown = {},
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  return api<T>(path, { method, body: JSON.stringify(body) }, csrf);
}

export async function downloadReport(weekStart: string): Promise<void> {
  const response = await fetch(
    `/api/reports/weekly.xlsx?weekStart=${encodeURIComponent(weekStart)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: 'Report download failed.' }))) as {
      error?: string;
    };
    throw new ApiError(body.error ?? 'Report download failed.', response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'weekly-time-report.xlsx';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function downloadClientReport(
  clientId: string,
  from: string,
  to: string,
): Promise<void> {
  const query = new URLSearchParams({ clientId, from, to });
  const response = await fetch(`/api/reports/client.pdf?${query}`);
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => ({ error: 'PDF report download failed.' }))) as {
      error?: string;
    };
    throw new ApiError(body.error ?? 'PDF report download failed.', response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename =
    disposition.match(/filename="([^"]+)"/)?.[1] ?? `client-time-${from}-to-${to}.pdf`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function downloadFinalizedReport(weekStart: string): Promise<void> {
  const response = await fetch(`/api/reports/finalized/${encodeURIComponent(weekStart)}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: 'Report download failed.' }))) as {
      error?: string;
    };
    throw new ApiError(body.error ?? 'Report download failed.', response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `final-report-${weekStart}.xlsx`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function downloadClosedReport(
  reportId: string,
  format: 'pdf' | 'csv' | 'xlsx',
): Promise<void> {
  const response = await fetch(
    `/api/reports/closed/${encodeURIComponent(reportId)}/${encodeURIComponent(format)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: 'Report download failed.' }))) as {
      error?: string;
    };
    throw new ApiError(body.error ?? 'Report download failed.', response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `closed-time-report.${format}`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
