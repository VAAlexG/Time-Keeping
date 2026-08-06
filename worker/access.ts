import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from './env';

export interface AccessIdentity {
  subject: string;
  entraObjectId?: string;
  email: string;
  displayName: string;
}

export type IdentityVerifier = (request: Request, env: Env) => Promise<AccessIdentity>;

const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function teamDomain(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudflareaccess.com')) {
    throw new Error('ACCESS_TEAM_DOMAIN is invalid');
  }
  return url.origin;
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export const verifyAccessIdentity: IdentityVerifier = async (request, env) => {
  const requestUrl = new URL(request.url);
  if (
    env.LOCAL_DEV_IDENTITY_EMAIL &&
    (requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1')
  ) {
    const email = env.LOCAL_DEV_IDENTITY_EMAIL.trim().toLowerCase();
    return {
      subject: `local:${email}`,
      email,
      displayName: email.split('@')[0],
    };
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new Error('Cloudflare Access is not configured');
  }
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new Error('Cloudflare Access token is missing');
  const domain = teamDomain(env.ACCESS_TEAM_DOMAIN);
  let jwks = jwksByDomain.get(domain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
    jwksByDomain.set(domain, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: domain,
    audience: env.ACCESS_AUD,
    algorithms: ['RS256'],
  });
  const subject = stringClaim(payload, 'sub');
  const email = stringClaim(payload, 'email')?.toLowerCase();
  if (!subject || !email || payload.type !== 'app') {
    throw new Error('Cloudflare Access identity is incomplete');
  }
  const custom = payload.custom;
  const entraObjectId =
    custom && typeof custom === 'object' && !Array.isArray(custom)
      ? ((custom as Record<string, unknown>).oid as string | undefined)
      : undefined;
  return {
    subject,
    entraObjectId: entraObjectId?.trim() || undefined,
    email,
    displayName: stringClaim(payload, 'name') ?? email.split('@')[0],
  };
};

export function isAllowedEmail(email: string, domain: string): boolean {
  const allowed = domain.trim().toLowerCase().replace(/^@/, '');
  const separator = email.lastIndexOf('@');
  return Boolean(allowed && separator > 0 && email.slice(separator + 1).toLowerCase() === allowed);
}

export function isAdminEmail(email: string, configured: string): boolean {
  const admins = configured
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}
