# gd-api

The GoodDoc API used by the plugin, running as a **Cloudflare Worker**:

| Part | File | Status |
|---|---|---|
| Key validation + session verification | `src/index.ts`, `src/keys.ts`, `src/tokens.ts` | Key store is a **mock** (`keys.ts`); replace it, keep the endpoints |
| Ambient relay | `src/relay.ts` (Durable Object), `src/sio2.ts` | Real |
| Offline ambient server | `fake-ambient-server.mjs` (Node) | Tests only |

Related repos: [`gd-plugin`](https://github.com/Vizru-Inc/gd-plugin) (SDK, demo host, e2e tests, developer guide) and [`gd-plugin-panel`](https://github.com/Vizru-Inc/gd-plugin-panel) (the iframe app).

## Run locally

```bash
pnpm install
cp .dev.vars.example .dev.vars     # add AMBIENT_SUBSCRIPTION_API_KEY
pnpm dev                           # wrangler dev on http://localhost:4000
```

Offline: run `pnpm fake-ambient` (stand-in ambient server on :4100) and add `AMBIENT_SERVER_URL=http://localhost:4100` to `.dev.vars`.

## Deploy to Cloudflare

**Dashboard (Workers Builds, connected to this GitHub repo):** Build command: *(none)*; deploy command: `npx wrangler deploy`. `wrangler.jsonc` tells Cloudflare everything else.

**Or from your machine:** `npx wrangler login`, then `pnpm run deploy`.

**Then set the secrets once** (dashboard → Worker → Settings → Variables and Secrets, or CLI):

```bash
npx wrangler secret put AMBIENT_SUBSCRIPTION_API_KEY   # from the ambient integration guide
npx wrangler secret put GD_TOKEN_SECRET                # any long random string
```

Then edit `vars` in `wrangler.jsonc` (or override them in the dashboard):

| Variable | |
|---|---|
| `AMBIENT_SERVER_URL` | Ambient server origin (`/socket.io/` is added) |
| `ALLOWED_ORIGINS` | Host-page origins that may use the mock `gd_test_` keys, comma-separated, `*` wildcards. **Add every host app's origin**, e.g. `https://app.vizru.com,http://localhost:*` |

Check it: `curl https://gd-api.<your-subdomain>.workers.dev/health` → `{"ok":true}`. Logs: `pnpm tail`.

The panel needs this URL at **build time** as `VITE_GD_API_BASE_URL`.

## Endpoints

| | |
|---|---|
| `POST /v1/keys/validate` `{ apiKey }` | From the SDK in the host page. Checks the key **and** the caller's `Origin` (falls back to `Referer`). Returns `{ tenantId, features, sessionToken, expiresAt }` |
| `POST /v1/sessions/verify` `{ sessionToken }` | From the panel. Returns the origin and features the token was issued for |
| `GET /health` | `{ ok: true }` |
| `GET /ambient` (WebSocket) | Ambient relay |

Mock keys: `gd_test_` + 8 or more letters/digits is valid on any origin in `ALLOWED_ORIGINS`; `gd_test_revoked1` returns 401. Session tokens are HMAC-signed with `GD_TOKEN_SECRET` and last one hour.

## Ambient relay

```
panel ──WebSocket /ambient──► AmbientRelay (Durable Object) ──Socket.IO v2 over WebSocket──► ambient AI server
         auth: gd session token                    + subscription key (secret)
```

- The ambient server's **Subscription API Key must stay secret** and it only speaks **Socket.IO v2** (Engine.IO 3). Browsers can't hold the key, and Workers can't run `socket.io-client`, so `sio2.ts` implements the small part of the v2 protocol needed (connect, events, ping), over a plain WebSocket.
- **One Durable Object per panel connection.** Durable Objects get a fresh CPU budget for every WebSocket message, so long visits can't exhaust it; they're on the Free plan (SQLite-backed).
- **Panel ↔ relay protocol:** JSON frames `{ event, data }`. The first frame is `auth { sessionToken }`, answered by `ready` or `auth_error`. Then the panel sends `init_ambient_session` and `ambient_process_audio`, and the relay forwards `connected`, `output_json` and `connection_closed`, plus `ambient_error` and `upstream_disconnected`. Full details are in `src/relay.ts`.
- **Upstream drops:** the relay reconnects and re-initialises the same `session_id`, so the server resumes the session.
- **Logging:** event names and sizes only, **never payloads** (patient data).

Upstream protocol: see the vendor's integration guide (keep it in `.private/`, which is gitignored).
