import { describe, expect, it } from 'vitest';
import { base64, decrypt, encrypt, randomSecret } from '../server/xero/crypto';
import { retrySeconds, xeroRequest } from '../server/xero/api';
import { enabled, isReviewer, requireAdmin, requireId, type XeroEnv } from '../server/xero/types';

const key = base64(new Uint8Array(32).fill(7)); // Test-only key; never a production credential.

describe('Xero connector safety boundaries', () => {
  it('requires explicit enablement', () => {
    expect(() => enabled({ XERO_ENABLED: 'false' } as XeroEnv)).toThrow();
    expect(() => enabled({ XERO_ENABLED: 'true' } as XeroEnv)).not.toThrow();
  });
  it('separates billing review from connection administration', () => {
    const actor = {
      id: 'test',
      email: 'suzieg@versatileaccounting.com.au',
      displayName: 'Suzie',
      role: 'employee',
    };
    expect(isReviewer(actor, { XERO_REVIEWER_EMAILS: actor.email } as XeroEnv)).toBe(true);
    expect(() => requireAdmin(actor)).toThrow();
  });
  it('requires a valid resource identifier', () => {
    expect(() => requireId('../Invoices')).toThrow();
    expect(requireId('A0000000-0000-4000-8000-000000000001')).toBe(
      'a0000000-0000-4000-8000-000000000001',
    );
  });
  it('generates distinct URL-safe OAuth state values', () => {
    const first = randomSecret();
    expect(first).not.toBe(randomSecret());
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('encrypts tokens with different IVs and authenticates their context', async () => {
    const first = await encrypt({ token: 'fixture-secret' }, key, 'test-context');
    const second = await encrypt({ token: 'fixture-secret' }, key, 'test-context');
    expect(first).not.toBe(second);
    expect(first).not.toContain('fixture-secret');
    expect(await decrypt(first, key, 'test-context')).toEqual({ token: 'fixture-secret' });
    await expect(decrypt(first, key, 'wrong-context')).rejects.toThrow();
  });
  it('rejects invalid encryption key configuration', async () => {
    await expect(encrypt({}, 'invalid-key', 'test')).rejects.toThrow();
  });
  it('will not send invoice writes or arbitrary URLs', async () => {
    for (const path of ['/Invoices', 'https://example.invalid/Time', '/Projects/../Invoices']) {
      await expect(
        xeroRequest({} as XeroEnv, path, {
          tenantId: 'fixture',
          method: 'POST',
          payload: '{}',
          idempotencyKey: 'fixture',
        }),
      ).rejects.toMatchObject({ code: 'ENDPOINT' });
    }
  });
  it('bounds rate-limit delays', () => {
    expect(retrySeconds('120')).toBe(120);
    expect(retrySeconds('999999')).toBe(86400);
    expect(retrySeconds('invalid')).toBe(60);
  });
});
