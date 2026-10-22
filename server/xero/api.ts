import { accessToken, connection } from './oauth';
import { XeroProblem, type XeroEnv } from './types';
const PROJECTS = 'https://api.xero.com/projects.xro/2.0';
const ACCOUNTING = 'https://api.xero.com/api.xro/2.0';
const guid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const allowedGet = new RegExp(
  `^/(ProjectsUsers|Projects(?:/${guid}(?:/(Tasks|Time)(?:/${guid})?)?)?)(?:\\?|$)`,
  'i',
);
const allowedPost = new RegExp(`^/Projects/${guid}/Time$`, 'i');
export function retrySeconds(header: string | null, now = Date.now()): number {
  const seconds =
    header && /^\d+$/.test(header)
      ? Number(header)
      : header
        ? Math.ceil((Date.parse(header) - now) / 1000)
        : 60;
  return Math.min(86400, Math.max(1, Number.isFinite(seconds) ? seconds : 60));
}
/** Only Projects time can be written. Invoices, payments, contacts and prices cannot be changed. */
export async function xeroRequest<T>(
  env: XeroEnv,
  path: string,
  options: {
    tenantId: string;
    method?: 'GET' | 'POST';
    payload?: string;
    idempotencyKey?: string;
    accounting?: boolean;
    fetcher?: typeof fetch;
    now?: number;
  },
): Promise<T> {
  const method = options.method ?? 'GET';
  const contactPath = new RegExp(`^/Contacts(?:/${guid}|\\?(?:[^#]*))?$`, 'i');
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('..') ||
    path.includes('#') ||
    (options.accounting
      ? method !== 'GET' || !contactPath.test(path)
      : method === 'POST'
        ? !allowedPost.test(path)
        : !allowedGet.test(path))
  )
    throw new XeroProblem('ENDPOINT', 'This Xero endpoint is not permitted.');
  if (method === 'POST' && (!options.idempotencyKey || !options.payload))
    throw new XeroProblem('WRITE_GUARD', 'A saved payload and idempotency key are required.');
  const fetcher = options.fetcher ?? fetch,
    now = options.now ?? Date.now();
  const current = await connection(env.DB);
  if (current && current.throttle_until > now)
    throw new XeroProblem(
      'RATE_LIMIT',
      'Xero requests are temporarily rate-limited.',
      429,
      Math.ceil((current.throttle_until - now) / 1000),
    );
  if (method === 'POST' && (!current || current.paused))
    throw new XeroProblem('PAUSED', 'Xero uploads are paused.', 409);
  const auth = await accessToken(env, fetcher, now);
  if (auth.tenantId !== options.tenantId)
    throw new XeroProblem(
      'TENANT_MISMATCH',
      'This record belongs to a different organisation.',
      409,
    );
  let response: Response;
  try {
    response = await fetcher(`${options.accounting ? ACCOUNTING : PROJECTS}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Xero-Tenant-Id': auth.tenantId,
        Accept: 'application/json',
        ...(method === 'POST'
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': options.idempotencyKey! }
          : {}),
      },
      ...(method === 'POST' ? { body: options.payload } : {}),
    });
  } catch {
    throw new XeroProblem(
      method === 'POST' ? 'AMBIGUOUS_WRITE' : 'NETWORK',
      method === 'POST'
        ? 'The upload response was lost. Check Xero and reconcile before any further upload.'
        : 'Xero could not be reached. Retry shortly.',
      503,
      60,
    );
  }
  if (response.status === 429) {
    const seconds = retrySeconds(response.headers.get('Retry-After'), now);
    await env.DB.prepare(
      'UPDATE xero_projects_connection SET throttle_until=MAX(throttle_until,?),updated_at=? WHERE id=1',
    )
      .bind(now + seconds * 1000, now)
      .run();
    throw new XeroProblem('RATE_LIMIT', 'Xero requested a pause before retrying.', 429, seconds);
  }
  if (response.status === 401) {
    await env.DB.prepare(
      'UPDATE xero_projects_connection SET expires_at=0,updated_at=? WHERE id=1 AND token_revision=?',
    )
      .bind(now, auth.revision)
      .run();
    throw new XeroProblem(
      'AUTH_EXPIRED',
      'Xero rejected the token. The next attempt will refresh it; reconnect if this continues.',
      503,
      60,
    );
  }
  if (!response.ok)
    throw new XeroProblem(
      method === 'POST' && (response.status === 408 || response.status >= 500)
        ? 'AMBIGUOUS_WRITE'
        : `XERO_HTTP_${response.status}`,
      `Xero returned HTTP ${response.status}. ${method === 'POST' && (response.status === 408 || response.status >= 500) ? 'Check Xero before retrying: the time may have been created.' : 'Review permissions, project, task and staff mappings.'}`,
      502,
    );
  try {
    return (await response.json()) as T;
  } catch {
    throw new XeroProblem(
      method === 'POST' ? 'AMBIGUOUS_WRITE' : 'RESPONSE',
      'Unreadable Xero response. Review before retrying.',
      502,
    );
  }
}
export async function projectPages<T>(
  env: XeroEnv,
  path: string,
  tenantId: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<T[]> {
  const all: T[] = [];
  const pageSize = 500;
  for (let page = 1; page <= 200; page++) {
    const body = await xeroRequest<{
      items?: T[];
      pagination?: { page?: number; pageCount?: number };
    }>(env, `${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=${pageSize}`, {
      tenantId,
      fetcher,
      now,
    });
    if (!Array.isArray(body.items))
      throw new XeroProblem('RESPONSE', 'Xero returned an incomplete list.', 502);
    all.push(...body.items);
    if (
      !body.items.length ||
      (body.pagination?.pageCount !== undefined && page >= body.pagination.pageCount) ||
      (body.pagination?.pageCount === undefined && body.items.length < pageSize)
    )
      return all;
  }
  throw new XeroProblem(
    'PAGINATION_LIMIT',
    'More than 100,000 records were returned. No complete catalogue was activated.',
    503,
  );
}

/** Accounting Contacts uses a different response envelope from Projects. */
export async function activeContactPages<T>(
  env: XeroEnv,
  tenantId: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<T[]> {
  const all: T[] = [];
  const pageSize = 100;
  for (let page = 1; page <= 1000; page += 1) {
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      includeArchived: 'false',
    });
    const body = await xeroRequest<{ Contacts?: T[] }>(env, `/Contacts?${query.toString()}`, {
      tenantId,
      accounting: true,
      fetcher,
      now,
    });
    if (!Array.isArray(body.Contacts)) {
      throw new XeroProblem('RESPONSE', 'Xero returned an incomplete contact list.', 502);
    }
    all.push(...body.Contacts);
    if (body.Contacts.length < pageSize) return all;
  }
  throw new XeroProblem(
    'PAGINATION_LIMIT',
    'More than 100,000 contacts were returned. No complete catalogue was activated.',
    503,
  );
}
