/**
 * Ambient relay: browser panel  <->  GoodDoc API  <->  ambient AI server.
 *
 * Why a relay: the ambient server authenticates with a Subscription API Key that
 * must stay secret, and it only speaks Socket.IO v2. The panel runs in the
 * browser, so it can hold neither. Instead the panel connects here with its
 * gd-plugin session token, and this relay opens the upstream connection with
 * the subscription key injected.
 *
 * Panel-facing protocol (Socket.IO v4, namespace /ambient) mirrors the
 * upstream one, minus the key:
 *   emit  init_ambient_session  { session_id, prompt, expected_output_json, need_transcription? }
 *   emit  ambient_process_audio { session_id, audio_file (base64 | binary), close_connection? }
 *   on    connected | output_json | connection_closed   (forwarded from upstream)
 *   on    ambient_error { message }   (upstream "error" events and relay errors)
 *   on    upstream_disconnected { reason }
 */
import { Server } from 'socket.io';
import ioV2 from 'socket.io-client'; // pinned to 2.5.0: the ambient server rejects v3/v4 clients

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function attachAmbientRelay(httpServer, { verifySessionToken, isAllowedOrigin, serverUrl, subscriptionApiKey }) {
  const upstreamBase = normalizeBaseUrl(serverUrl);
  const configured = Boolean(upstreamBase && subscriptionApiKey);
  console.log(
    configured
      ? `[ambient] relay -> ${upstreamBase}/ambient`
      : '[ambient] relay NOT configured: set AMBIENT_SERVER_URL and AMBIENT_SUBSCRIPTION_API_KEY in .env (gd-api)',
  );

  const io = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)) },
    maxHttpBufferSize: MAX_AUDIO_BYTES,
  });

  const nsp = io.of('/ambient');

  // Only panels holding a valid gd-plugin session (with the ambient feature) may connect.
  nsp.use((socket, next) => {
    const claims = verifySessionToken(socket.handshake.auth?.sessionToken);
    if (!claims) return next(new Error('Session token is invalid or expired'));
    if (!claims.features?.includes('ambient')) return next(new Error('Ambient is not enabled for this account'));
    socket.data.claims = claims;
    next();
  });

  nsp.on('connection', (client) => {
    const tag = `[ambient ${client.id.slice(0, 6)} ${client.data.claims.tenantId}]`;
    let upstream = null;
    let sessionId = null;
    let chunks = 0;

    const closeUpstream = () => {
      if (!upstream) return;
      upstream.removeAllListeners();
      upstream.disconnect();
      upstream = null;
    };

    client.on('init_ambient_session', (payload = {}) => {
      if (!configured) {
        return client.emit('ambient_error', { message: 'Ambient is not configured on the GoodDoc API (missing server URL or subscription key)' });
      }
      const { session_id, prompt, expected_output_json, need_transcription = true } = payload;
      if (!session_id || !prompt || !expected_output_json) {
        return client.emit('ambient_error', { message: 'Missing required fields: session_id, prompt and expected_output_json' });
      }

      closeUpstream();
      sessionId = String(session_id);
      chunks = 0;
      let everConnected = false;

      upstream = ioV2(`${upstreamBase}/ambient`, {
        transports: ['websocket', 'polling'],
        forceNew: true,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
        timeout: 20000,
      });

      // (Re)initialise on every transport connect, as the reference client does,
      // so a reconnect resumes the same session_id server-side.
      upstream.on('connect', () => {
        everConnected = true;
        console.log(`${tag} upstream connected, init session ${sessionId}`);
        upstream.emit('init_ambient_session', {
          subscription_api_key: subscriptionApiKey,
          session_id: sessionId,
          prompt,
          expected_output_json,
          need_transcription,
        });
      });

      upstream.on('connect_error', (err) => {
        console.warn(`${tag} upstream connect_error: ${err?.message ?? err}`);
        if (!everConnected) {
          client.emit('ambient_error', { message: `Ambient server unreachable: ${err?.message ?? 'connection failed'}` });
          closeUpstream();
        }
      });

      upstream.on('disconnect', (reason) => {
        console.log(`${tag} upstream disconnected: ${reason}`);
        client.emit('upstream_disconnected', { reason });
      });

      for (const event of ['connected', 'output_json', 'connection_closed']) {
        upstream.on(event, (data) => {
          console.log(`${tag} <- ${event}`); // never log payloads: they contain PHI
          client.emit(event, data);
          if (event === 'connection_closed') closeUpstream();
        });
      }

      upstream.on('error', (data) => {
        const message = parseError(data);
        console.warn(`${tag} upstream error: ${message}`);
        client.emit('ambient_error', { message });
      });
    });

    client.on('ambient_process_audio', (payload = {}) => {
      if (!upstream?.connected) {
        return client.emit('ambient_error', { message: 'Not an ambient session: wait for "connected" before sending audio' });
      }
      if (payload.session_id !== sessionId) {
        return client.emit('ambient_error', { message: 'Session ID mismatch' });
      }
      const audio = payload.audio_file;
      const size = typeof audio === 'string' ? audio.length : audio?.byteLength ?? 0;
      if (!size && !payload.close_connection) return;
      chunks++;
      console.log(`${tag} -> audio #${chunks} ${(size / 1024).toFixed(1)} KB${payload.close_connection ? ' (final)' : ''}`);
      upstream.emit('ambient_process_audio', {
        session_id: sessionId,
        audio_file: audio,
        close_connection: Boolean(payload.close_connection),
      });
    });

    client.on('disconnect', (reason) => {
      console.log(`${tag} panel disconnected: ${reason}`);
      closeUpstream();
    });
  });

  return io;
}

function normalizeBaseUrl(url) {
  if (!url) return '';
  const cleaned = url.trim().replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  try {
    const u = new URL(cleaned);
    return `${u.protocol}//${u.host}`; // socket host is origin only
  } catch {
    return cleaned.replace(/\/$/, '');
  }
}

/** Upstream errors arrive as a string, { message }, or ["error", { message }]. */
function parseError(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    const obj = data.find((d) => d && typeof d === 'object' && 'message' in d);
    if (obj?.message) return obj.message;
    const str = data.find((d) => typeof d === 'string' && d !== 'error');
    if (str) return str;
  }
  if (data && typeof data === 'object' && typeof data.message === 'string') return data.message;
  return 'Unknown ambient server error';
}
