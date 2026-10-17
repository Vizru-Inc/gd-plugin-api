/**
 * GoodDoc API (Cloudflare Worker).
 *
 *   POST /v1/keys/validate   { apiKey, devMode? } SDK in the host page → session token for the caller's origin (MOCK key store)
 *   POST /v1/sessions/verify { sessionToken }  panel → who the token was issued to + panel config (see panel-config.ts)
 *   POST /v1/voice/session   { sessionToken, sessionContext, admissionId, patientName, isInpatient }
 *                                              panel → starts an Eva voice session (proxies the workflow trigger, see voice.ts)
 *   POST /v1/events          { sessionToken, event, payload }
 *                                              panel → every panel event, forwarded to the event receiver workflow (see events.ts)
 *   GET  /health
 *   GET  /ambient  (WebSocket)                 panel → ambient relay (Durable Object, see relay.ts)
 *
 * Plugin events (contract: @gooddoc/gd-contracts):
 *   GET  /v1/stream?sid=<sessionId> (WebSocket) panel ⇄ its EventSession (Durable Object, see session.ts)
 *   POST /v1/emitter/callback/{route}          Emitter → frames for a run (HMAC-signed)
 *
 * Dev mode (session token with devMode, test keys only):
 *   POST /v1/debug/push { sessionToken, entries, facts }  panel → its dev log, stored in its EventSession
 *   GET  /v1/debug?sid=<sessionId>             debug page → everything for that session (no auth by design)
 */
import type { Env } from './env';
import { lookupKey } from './keys';
import { issueToken, readToken } from './tokens';
import { eventsConfigured, forwardEvent } from './events';
import { startVoiceSession } from './voice';
import { publicPanelConfig } from './panel-config';
import { readRoute, SESSION_ID_RE } from './emitter';
import { CALLBACK_PATH_PREFIX, sessionIdFor, verifyRequest } from '@gooddoc/gd-contracts';

export { AmbientRelay } from './relay';
export { EventSession } from './session';

const SESSION_TTL_MS = 60 * 60 * 1000;

/** The calling page's origin: Origin header, else the origin of Referer. */
function requestOrigin(req: Request): string | null {
  const origin = req.headers.get('Origin');
  if (origin && origin !== 'null') return origin;
  try {
    const ref = req.headers.get('Referer');
    return ref ? new URL(ref).origin : null;
  } catch {
    return null;
  }
}

function json(status: number, body: unknown, req: Request): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  cors(headers, req);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Reflect the origin; real authorisation is the key's allowed origins and the session token. */
function cors(headers: Headers, req: Request) {
  const origin = req.headers.get('Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'OPTIONS') {
      const headers = new Headers();
      cors(headers, req);
      return new Response(null, { status: 204, headers });
    }

    if (route === 'GET /health') return json(200, { ok: true }, req);

    if (route === 'GET /ambient') {
      // One Durable Object per connection; it authenticates with the first message.
      const stub = env.AMBIENT_RELAY.get(env.AMBIENT_RELAY.newUniqueId());
      return stub.fetch(req);
    }

    if (!env.GD_TOKEN_SECRET) {
      return json(500, { error: 'Server misconfigured: GD_TOKEN_SECRET is not set' }, req);
    }

    if (route === 'GET /v1/stream') {
      // The panel names its session (sid = hash of its token, not secret); it proves the token in the first frame.
      const sid = url.searchParams.get('sid') ?? '';
      if (!SESSION_ID_RE.test(sid)) return json(400, { error: 'sid is required' }, req);
      if (req.headers.get('Upgrade') !== 'websocket') return json(426, { error: 'Expected a WebSocket upgrade' }, req);
      const forwarded = new Request('https://session/connect', req);
      forwarded.headers.set('X-GD-Session-Id', sid);
      forwarded.headers.set('X-GD-Public-Origin', url.origin);
      return env.EVENT_SESSION.get(env.EVENT_SESSION.idFromName(sid)).fetch(forwarded);
    }

    if (route === 'GET /v1/debug') {
      const sid = url.searchParams.get('sid') ?? '';
      if (!SESSION_ID_RE.test(sid)) return json(400, { error: 'sid is required' }, req);
      const snapshot = await env.EVENT_SESSION.get(env.EVENT_SESSION.idFromName(sid)).debugSnapshot();
      if (!snapshot) return json(404, { error: 'No dev-mode session with this id' }, req);
      return json(200, snapshot, req);
    }

    if (req.method === 'POST' && url.pathname.startsWith(CALLBACK_PATH_PREFIX)) {
      if (!env.EMITTER_CALLBACK_SECRET) return Response.json({ error: { code: 'emitter_not_configured' } }, { status: 503 });
      const body = await req.text();
      const verified = await verifyRequest(
        [env.EMITTER_CALLBACK_SECRET, env.EMITTER_CALLBACK_SECRET_NEXT],
        req.headers.get('X-GD-Timestamp'),
        req.headers.get('X-GD-Signature'),
        body,
      );
      if (!verified.ok) return Response.json({ error: { code: verified.code } }, { status: 401 });
      const sid = await readRoute(env.GD_TOKEN_SECRET, url.pathname.slice(CALLBACK_PATH_PREFIX.length));
      if (!sid) return Response.json({ error: { code: 'unknown_route' } }, { status: 404 });
      return env.EVENT_SESSION.get(env.EVENT_SESSION.idFromName(sid)).fetch('https://session/callback', { method: 'POST', body });
    }

    if (route === 'POST /v1/keys/validate') {
      const body = await readJson(req);
      if (!body) return json(400, { error: 'Invalid JSON' }, req);
      const key = lookupKey(body.apiKey, env.ALLOWED_ORIGINS);
      if (!key) return json(401, { valid: false, error: 'API key is invalid or revoked' }, req);
      const origin = requestOrigin(req);
      if (!origin) {
        return json(403, { valid: false, error: 'No Origin or Referer header. Call this from a browser page (the host app).' }, req);
      }
      if (!key.isAllowed(origin)) return json(403, { valid: false, error: `Origin ${origin} is not allowed for this key` }, req);
      const exp = Date.now() + SESSION_TTL_MS;
      // Dev mode (internals shown in the panel) is only ever granted to test keys.
      const devMode = body.devMode === true && String(body.apiKey).startsWith('gd_test_');
      const sessionToken = await issueToken(env.GD_TOKEN_SECRET, { tenantId: key.tenantId, origin, features: key.features, exp, ...(devMode && { devMode }) });
      console.log(`validate 200 origin=${origin}`);
      return json(200, {
        valid: true,
        tenantId: key.tenantId,
        features: key.features,
        allowedOrigins: key.allowedOrigins,
        sessionToken,
        expiresAt: new Date(exp).toISOString(),
        devMode,
      }, req);
    }

    if (route === 'POST /v1/sessions/verify') {
      const body = await readJson(req);
      const claims = body ? await readToken(env.GD_TOKEN_SECRET, body.sessionToken) : null;
      if (!claims) return json(401, { valid: false, error: 'Session token is invalid or expired' }, req);
      return json(200, {
        valid: true,
        tenantId: claims.tenantId,
        origin: claims.origin,
        features: claims.features,
        devMode: !!claims.devMode,
        expiresAt: new Date(claims.exp).toISOString(),
        config: publicPanelConfig(),
      }, req);
    }

    if (route === 'POST /v1/debug/push') {
      const body = await readJson(req);
      const claims = body ? await readToken(env.GD_TOKEN_SECRET, body.sessionToken) : null;
      if (!body || !claims) return json(401, { error: 'Session token is invalid or expired' }, req);
      if (!claims.devMode) return json(403, { error: 'Dev mode is not enabled for this session' }, req);
      const sid = await sessionIdFor(String(body.sessionToken));
      const entries = Array.isArray(body.entries) ? body.entries.slice(-200) : [];
      const facts = body.facts && typeof body.facts === 'object' ? (body.facts as Record<string, unknown>) : null;
      const ok = await env.EVENT_SESSION.get(env.EVENT_SESSION.idFromName(sid)).debugPush(entries, facts);
      return ok ? json(200, { ok: true, sid }, req) : json(409, { error: 'Session not connected yet' }, req);
    }

    if (route === 'POST /v1/events') {
      const body = await readJson(req);
      const claims = body ? await readToken(env.GD_TOKEN_SECRET, body.sessionToken) : null;
      if (!body || !claims) return json(401, { error: 'Session token is invalid or expired' }, req);
      const event = typeof body.event === 'string' ? body.event.trim().slice(0, 200) : '';
      if (!event) return json(400, { error: 'event is required' }, req);
      if (!eventsConfigured(env)) return json(500, { error: 'Server misconfigured: WORKFLOW_BASE_URL / EVENTS_WORKFLOW are not set' }, req);
      // Answer straight away; delivery to the receiver finishes in the background.
      ctx.waitUntil(forwardEvent(env, event, body.payload, claims.origin).catch((err) => console.error(`event ${event} failed`, err)));
      return json(202, { accepted: true }, req);
    }

    if (route === 'POST /v1/voice/session') {
      const body = await readJson(req);
      const claims = body ? await readToken(env.GD_TOKEN_SECRET, body.sessionToken) : null;
      if (!body || !claims) return json(401, { error: 'Session token is invalid or expired' }, req);
      const result = await startVoiceSession(env, body);
      console.log(`voice/session ${result.status} tenant=${claims.tenantId}`);
      return json(result.status, result.body, req);
    }

    return json(404, { error: 'Not found' }, req);
  },
} satisfies ExportedHandler<Env>;
