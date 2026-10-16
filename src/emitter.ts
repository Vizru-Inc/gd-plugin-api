/**
 * The two server-to-server hops with the Emitter:
 *   dispatch   gd-api → Emitter   POST {EMITTER_URL}/v1/events      (signed with EMITTER_DISPATCH_SECRET)
 *   callback   Emitter → gd-api   POST /v1/emitter/callback/{route} (signed with EMITTER_CALLBACK_SECRET)
 *
 * `route` = "<sessionId>.<mac>": names the session's Durable Object and can't be forged,
 * so a callback goes straight to the right session without a lookup.
 */
import { DISPATCH_PATH, signRequest, type DispatchRequest } from '@gooddoc/gd-contracts';
import type { Env } from './env';

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function routeMac(secret: string, sessionId: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`callback-route:${sessionId}`))).slice(0, 32);
}

export const SESSION_ID_RE = /^[\w-]{16,64}$/;

export async function makeRoute(secret: string, sessionId: string): Promise<string> {
  return `${sessionId}.${await routeMac(secret, sessionId)}`;
}

/** The session id if the route is genuine, else null. */
export async function readRoute(secret: string, route: string): Promise<string | null> {
  const m = /^([\w-]{16,64})\.([\w-]{32})$/.exec(route);
  if (!m) return null;
  const expected = await routeMac(secret, m[1]);
  // Constant-time compare of two equal-length strings.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0 ? m[1] : null;
}

export function emitterConfigured(env: Env): boolean {
  return !!(env.EMITTER_URL && env.EMITTER_DISPATCH_SECRET && env.EMITTER_CALLBACK_SECRET);
}

export type DispatchOutcome =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: number; code: string; retryable: boolean };

const RETRY_DELAYS_MS = [500, 1000, 2000];
const DISPATCH_TIMEOUT_MS = 5000;

/** POST one event to the Emitter, retrying 429/5xx/network errors 3 times with the same body. */
export async function dispatch(env: Env, request: DispatchRequest): Promise<DispatchOutcome> {
  const url = `${env.EMITTER_URL!.replace(/\/$/, '')}${DISPATCH_PATH}`;
  const body = JSON.stringify(request);
  let last: DispatchOutcome = { ok: false, status: 0, code: 'emitter_unavailable', retryable: true };
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await signRequest(env.EMITTER_DISPATCH_SECRET!, body)) },
        body,
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      if (res.status === 202 || res.status === 200) {
        const json = (await res.json().catch(() => ({}))) as { duplicate?: boolean };
        return { ok: true, duplicate: !!json.duplicate };
      }
      const err = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error;
      last = { ok: false, status: res.status, code: err?.code ?? `http_${res.status}`, retryable: res.status === 429 || res.status >= 500 };
      if (!last.retryable) return last;
    } catch (e) {
      last = { ok: false, status: 0, code: 'emitter_unavailable', retryable: true };
      console.warn(`dispatch ${request.event.type} attempt ${attempt + 1} failed: ${(e as Error).name}`);
    }
  }
  return last;
}
