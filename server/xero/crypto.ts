import { XeroProblem } from './types';
const encoder = new TextEncoder();
export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
}
export function randomSecret(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
async function key(raw: string | undefined): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unbase64(raw ?? '');
  } catch {
    throw new XeroProblem('CONFIGURATION', 'The Xero encryption key is not configured.', 503);
  }
  if (bytes.length !== 32)
    throw new XeroProblem(
      'CONFIGURATION',
      'Configure a 32-byte base64 XERO_TOKEN_KEY secret.',
      503,
    );
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(
  value: unknown,
  rawKey: string | undefined,
  context: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await key(rawKey),
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function decrypt<T>(
  value: string,
  rawKey: string | undefined,
  context: string,
): Promise<T> {
  const [version, iv, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !ciphertext)
    throw new XeroProblem(
      'TOKEN_STORAGE',
      'Stored Xero credentials could not be read. Reconnect securely.',
      503,
    );
  try {
    const bytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(iv), additionalData: encoder.encode(context) },
      await key(rawKey),
      unbase64(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new XeroProblem(
      'TOKEN_STORAGE',
      'Stored Xero credentials could not be read. Check the encryption key or reconnect.',
      503,
    );
  }
}
