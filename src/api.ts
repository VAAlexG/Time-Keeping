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
