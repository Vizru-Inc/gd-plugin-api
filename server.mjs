/**
 * GoodDoc API for local development: `node server.mjs`.
 *
 *   POST /v1/keys/validate   { apiKey }        -> session token for the caller's Origin (mocked)
 *   POST /v1/sessions/verify { sessionToken }  -> who the token was issued to (mocked)
 *   Socket.IO /ambient                         -> REAL relay to the ambient AI server (see ambient-relay.mjs)
 *
 * Test keys:
 *   gd_test_<8+ alphanumerics>   valid on any localhost / 127.0.0.1 origin
 *   gd_test_revoked1             401 (revoked)
 *   gd_live_…                    401 (live keys aren't issued by the mock)
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from './env.mjs';
import { attachAmbientRelay } from './ambient-relay.mjs';

loadEnv(new URL('./.env', import.meta.url));

const PORT = Number(process.env.PORT ?? 4000);
const SECRET = process.env.GD_MOCK_SECRET ?? 'dev-only-secret';
const SESSION_TTL_MS = 60 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => b64url(createHmac('sha256', SECRET).update(data).digest());

function issueToken(claims) {
  const body = b64url(JSON.stringify(claims));
  return `gdst_${body}.${sign(body)}`;
}

function readToken(token) {
  const m = /^gdst_([\w-]+)\.([\w-]+)$/.exec(token ?? '');
  if (!m) return null;
  const [, body, sig] = m;
  const expected = Buffer.from(sign(body));
  if (expected.length !== sig.length || !timingSafeEqual(expected, Buffer.from(sig))) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    return claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

/**
 * The calling page's origin. Browsers send Origin on cross-origin requests;
 * some setups (same-origin dev proxies, privacy extensions, older browsers)
 * only send Referer, so fall back to its origin.
 */
function requestOrigin(req) {
  if (req.headers.origin && req.headers.origin !== 'null') return req.headers.origin;
  try {
    return req.headers.referer ? new URL(req.headers.referer).origin : undefined;
  } catch {
    return undefined;
  }
}

const isLocalOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? '');

const KEYS = {
  revoked: new Set(['gd_test_revoked1']),
};

function lookupKey(apiKey) {
  if (!/^gd_test_[A-Za-z0-9]{8,}$/.test(apiKey ?? '') || KEYS.revoked.has(apiKey)) return null;
  return {
    tenantId: 'tnt_demo_dental',
    features: ['ambient', 'scheduler', 'reports', 'visit-summary', 'launcher'],
    allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],
    isAllowed: isLocalOrigin,
  };
}

const routes = {
  'POST /v1/keys/validate': async ({ body, origin }) => {
    await new Promise((r) => setTimeout(r, 250)); // feel like a network call
    const key = lookupKey(body.apiKey);
    if (!key) return [401, { valid: false, error: 'API key is invalid or revoked' }];
    if (!origin) {
      return [403, { valid: false, error: 'No Origin or Referer header. Call this from a browser page (the host app), not from Postman/curl/server-side code.' }];
    }
    if (!key.isAllowed(origin)) return [403, { valid: false, error: `Origin ${origin} is not allowed for this key` }];
    const exp = Date.now() + SESSION_TTL_MS;
    return [
      200,
      {
        valid: true,
        tenantId: key.tenantId,
        features: key.features,
        allowedOrigins: key.allowedOrigins,
        sessionToken: issueToken({ tenantId: key.tenantId, origin, features: key.features, exp }),
        expiresAt: new Date(exp).toISOString(),
      },
    ];
  },

  'POST /v1/sessions/verify': async ({ body }) => {
    const claims = readToken(body.sessionToken);
    if (!claims) return [401, { valid: false, error: 'Session token is invalid or expired' }];
    return [200, { valid: true, tenantId: claims.tenantId, origin: claims.origin, features: claims.features }];
  },

  'GET /health': async () => [200, { ok: true }],
};

const httpServer = createServer(async (req, res) => {
  const origin = requestOrigin(req);
  // Reflect the origin for CORS; the real authorization is the key/origin check above.
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const route = routes[`${req.method} ${req.url?.split('?')[0]}`];
  if (!route) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Not found"}');

  // The browser may cancel a request mid-flight (page refresh, React StrictMode
  // unmounting the provider). That must never take the server down.
  const send = (status, payload) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  };

  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(400, { error: 'Invalid JSON' });
    }

    const [status, payload] = await route({ body, origin });
    const cancelled = req.socket.destroyed;
    console.log(`${req.method} ${req.url} ${status} origin=${origin ?? '-'}${cancelled ? ' (client cancelled)' : ''}`);
    send(status, payload);
  } catch (err) {
    if (err?.code === 'ECONNRESET' || err?.message === 'aborted') {
      console.log(`${req.method} ${req.url} cancelled by client`);
      return;
    }
    console.error(`${req.method} ${req.url} failed:`, err);
    send(500, { error: 'Internal error' });
  }
});

// Last line of defence for a dev server: log, don't exit.
process.on('unhandledRejection', (err) => console.error('[api] unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[api] uncaught exception:', err));

attachAmbientRelay(httpServer, {
  verifySessionToken: readToken,
  isAllowedOrigin: isLocalOrigin,
  serverUrl: process.env.AMBIENT_SERVER_URL,
  subscriptionApiKey: process.env.AMBIENT_SUBSCRIPTION_API_KEY,
});

httpServer.listen(PORT, () => console.log(`GoodDoc API on http://localhost:${PORT}`));
