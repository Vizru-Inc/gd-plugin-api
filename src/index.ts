/**
 * GoodDoc API (Cloudflare Worker).
 *
 *   POST /v1/keys/validate   { apiKey }        SDK in the host page → session token for the caller's origin (MOCK key store)
 *   POST /v1/sessions/verify { sessionToken }  panel → who the token was issued to
 *   POST /v1/voice/session   { sessionToken, agentPrompt, admissionId, patientName, isInpatient }
 *                                              panel → starts an Eva voice session (proxies the workflow trigger, see voice.ts)
 *   POST /v1/events          { sessionToken, event, payload }
 *                                              panel → every panel event, forwarded to the event receiver workflow (see events.ts)
 *   GET  /health
 *   GET  /ambient  (WebSocket)                 panel → ambient relay (Durable Object, see relay.ts)
 */
import type { Env } from './env';
import { lookupKey } from './keys';
import { issueToken, readToken } from './tokens';
import { eventsConfigured, forwardEvent } from './events';
import { startVoiceSession } from './voice';

export { AmbientRelay } from './relay';

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
      const sessionToken = await issueToken(env.GD_TOKEN_SECRET, { tenantId: key.tenantId, origin, features: key.features, exp });
      console.log(`validate 200 origin=${origin}`);
      return json(200, {
        valid: true,
        tenantId: key.tenantId,
        features: key.features,
        allowedOrigins: key.allowedOrigins,
        sessionToken,
        expiresAt: new Date(exp).toISOString(),
      }, req);
    }

    if (route === 'POST /v1/sessions/verify') {
      const body = await readJson(req);
      const claims = body ? await readToken(env.GD_TOKEN_SECRET, body.sessionToken) : null;
      if (!claims) return json(401, { valid: false, error: 'Session token is invalid or expired' }, req);
      return json(200, { valid: true, tenantId: claims.tenantId, origin: claims.origin, features: claims.features }, req);
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
