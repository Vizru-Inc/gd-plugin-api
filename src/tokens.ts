/**
 * Session tokens: `gdst_<base64url(json claims)>.<base64url(hmac-sha256)>`.
 * Same format as the original Node server, implemented with Web Crypto.
 */
export interface SessionClaims {
  tenantId: string;
  origin: string;
  features: string[];
  exp: number;
  /** Dev mode granted at key validation (test keys only). */
  devMode?: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueToken(secret: string, claims: SessionClaims): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `gdst_${body}.${b64url(sig)}`;
}

export async function readToken(secret: string, token: unknown): Promise<SessionClaims | null> {
  const m = /^gdst_([\w-]+)\.([\w-]+)$/.exec(typeof token === 'string' ? token : '');
  if (!m) return null;
  const [, body, sig] = m;
  try {
    // crypto.subtle.verify compares in constant time.
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const claims = JSON.parse(dec.decode(fromB64url(body))) as SessionClaims;
    return claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}
