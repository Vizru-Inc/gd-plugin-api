# gd-api

The GoodDoc API used by the plugin:

| Part | File | Status |
|---|---|---|
| Key validation + session verification | `server.mjs` | **Mock.** Replace with the real GoodDoc API |
| Ambient relay (Socket.IO `/ambient`) | `ambient-relay.mjs` | **Real.** Move it into the real API as is |
| Offline ambient server | `fake-ambient-server.mjs` | Tests only |

Related repos: [`gd-plugin`](../gd-plugin) (SDK, demo host, e2e tests, developer guide) and [`gd-panel`](../gd-panel) (the iframe app).

## Run

```bash
pnpm install
cp .env.example .env      # add the ambient subscription key
pnpm dev                  # http://localhost:4000, restarts on file changes
```

The first log line confirms the relay target: `[ambient] relay -> https://…/ambient`. If it says `relay NOT configured`, `.env` is missing or a value is empty.

Offline: `pnpm fake-ambient` starts a stand-in ambient server on :4100. Set `AMBIENT_SERVER_URL=http://localhost:4100` and any key in `.env`.

## Endpoints

| | |
|---|---|
| `POST /v1/keys/validate` `{ apiKey }` | Called by the SDK in the host page. Checks the key **and** the caller's `Origin` (falls back to `Referer`). Returns `{ tenantId, features, sessionToken, expiresAt }`. |
| `POST /v1/sessions/verify` `{ sessionToken }` | Called by the panel. Returns the origin and features the token was issued for. |
| `GET /health` | `{ ok: true }` |
| Socket.IO `/ambient` | Ambient relay, below |

Mock keys: `gd_test_` + 8 or more letters/digits is valid on any `localhost` / `127.0.0.1` origin. `gd_test_revoked1` returns 401. Session tokens are HMAC-signed with `GD_MOCK_SECRET` (dev default) and last one hour.

## Ambient relay

```
panel ──Socket.IO v4 /ambient──► relay ──Socket.IO v2 /ambient──► ambient AI server
        auth: gd session token          + subscription key
```

The ambient server authenticates with a **Subscription API Key that must stay secret**, and only accepts Socket.IO **v2** clients. The panel runs in browsers, so it can hold neither. It connects here with the session token from the plugin handshake. The relay:

1. Rejects the connection unless the token is valid and the account has the `ambient` feature.
2. On `init_ambient_session`, opens an upstream v2 connection and adds `subscription_api_key`. It re-initialises the same `session_id` after a reconnect, so the server resumes the session.
3. Forwards `ambient_process_audio` upstream, and `connected`, `output_json` and `connection_closed` back. Upstream `error` events and relay errors reach the panel as `ambient_error`.
4. Logs event names and audio sizes only, **never payloads** (they contain patient data).

Upstream protocol: see the vendor's integration guide (keep it in `.private/`, which is gitignored).

## Configuration

| Variable | |
|---|---|
| `PORT` | Default `4000` |
| `AMBIENT_SERVER_URL` | Ambient server origin, e.g. `https://roverv2-fastapi.vizru-ras.com` (`/ambient` is added) |
| `AMBIENT_SUBSCRIPTION_API_KEY` | **Secret.** Only ever in `.env` or your secret manager |
| `GD_MOCK_SECRET` | Signs mock session tokens. Set a real secret anywhere but your machine |

## Deploying

- Needs WebSocket support. If you run several instances, enable sticky sessions, because Socket.IO's polling fallback needs them.
- CORS is reflected per origin; real authorisation is the key's allowed origins and the session token.
- When replacing the mock: keep the two endpoint contracts (the SDK and panel depend on them), store keys with per-vendor allowed origins, and keep `features` in the token, because the relay enforces it.
