/**
 * Ambient relay, one Durable Object per panel connection:
 *
 *   panel ──WebSocket /ambient──► AmbientRelay ──Socket.IO v2 (WebSocket)──► ambient AI server
 *          auth: gd session token        + subscription key (secret)
 *
 * Panel ↔ relay messages are JSON text frames: { "event": string, "data"?: any }
 *   panel → relay   auth { sessionToken }                       (must be first, within 10 s)
 *                   init_ambient_session { session_id, prompt, expected_output_json, need_transcription? }
 *                   ambient_process_audio { session_id, audio_file (base64), close_connection? }
 *   relay → panel   ready                                        auth accepted
 *                   auth_error { message }                       then the socket closes
 *                   connected | output_json | connection_closed  forwarded from the ambient server
 *                   ambient_error { message }                    upstream "error" events and relay errors
 *                   upstream_disconnected { reason }             relay is reconnecting upstream
 *
 * A Durable Object (not a plain Worker) because its CPU budget resets on every
 * WebSocket message, so a long visit can't exhaust it. Never log payloads (PHI).
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { readToken } from './tokens';
import { Sio2Client } from './sio2';

const AUTH_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_RETRIES = 10;
const RETRY_DELAY_MS = 2_000;

interface InitPayload {
  session_id: string;
  prompt: string;
  expected_output_json: unknown;
  need_transcription?: boolean;
}

export class AmbientRelay extends DurableObject<Env> {
  private client: WebSocket | null = null;
  private authed = false;
  private tag = '[ambient]';
  private upstream: Sio2Client | null = null;
  private init: InitPayload | null = null;
  private everConnected = false;
  private retries = 0;
  private chunks = 0;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });

    const [clientSide, serverSide] = Object.values(new WebSocketPair());
    serverSide.accept();
    this.client = serverSide;

    const authTimer = setTimeout(() => {
      if (!this.authed) this.reject('Authentication timed out');
    }, AUTH_TIMEOUT_MS);

    serverSide.addEventListener('message', (ev) => {
      let msg: { event?: string; data?: any };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return this.send('ambient_error', { message: 'Malformed message' });
      }
      if (!this.authed) {
        clearTimeout(authTimer);
        return void this.authenticate(msg);
      }
      if (msg.event === 'init_ambient_session') return void this.startSession(msg.data ?? {});
      if (msg.event === 'ambient_process_audio') return this.forwardAudio(msg.data ?? {});
    });
    serverSide.addEventListener('close', () => {
      console.log(`${this.tag} panel disconnected`);
      this.closeUpstream();
      this.client = null;
    });

    return new Response(null, { status: 101, webSocket: clientSide });
  }

  // ── panel side ──

  private send(event: string, data?: unknown) {
    try {
      this.client?.send(JSON.stringify({ event, data }));
    } catch {
      /* panel gone */
    }
  }

  private reject(message: string) {
    this.send('auth_error', { message });
    try {
      this.client?.close(4401, message.slice(0, 120));
    } catch {
      /* already closed */
    }
  }

  private async authenticate(msg: { event?: string; data?: any }) {
    if (msg.event !== 'auth') return this.reject('First message must be auth');
    if (!this.env.GD_TOKEN_SECRET) return this.reject('Server misconfigured: GD_TOKEN_SECRET is not set');
    const claims = await readToken(this.env.GD_TOKEN_SECRET, msg.data?.sessionToken);
    if (!claims) return this.reject('Session token is invalid or expired');
    if (!claims.features?.includes('ambient')) return this.reject('Ambient is not enabled for this account');
    this.authed = true;
    this.tag = `[ambient ${claims.tenantId}]`;
    this.send('ready');
  }

  private forwardAudio(p: { session_id?: string; audio_file?: unknown; close_connection?: boolean }) {
    if (!this.upstream?.connected || !this.init) {
      return this.send('ambient_error', { message: 'Not an ambient session: wait for "connected" before sending audio' });
    }
    if (p.session_id !== this.init.session_id) return this.send('ambient_error', { message: 'Session ID mismatch' });
    const size = typeof p.audio_file === 'string' ? p.audio_file.length : 0;
    if (!size && !p.close_connection) return;
    this.chunks++;
    console.log(`${this.tag} -> audio #${this.chunks} ${(size / 1024).toFixed(1)} KB${p.close_connection ? ' (final)' : ''}`);
    this.upstream.emit('ambient_process_audio', {
      session_id: this.init.session_id,
      audio_file: p.audio_file ?? '',
      close_connection: Boolean(p.close_connection),
    });
  }

  // ── ambient server side ──

  private async startSession(p: Partial<InitPayload>) {
    const { AMBIENT_SERVER_URL: base, AMBIENT_SUBSCRIPTION_API_KEY: key } = this.env;
    if (!base || !key) {
      return this.send('ambient_error', { message: 'Ambient is not configured on the GoodDoc API (missing server URL or subscription key)' });
    }
    if (!p.session_id || !p.prompt || !p.expected_output_json) {
      return this.send('ambient_error', { message: 'Missing required fields: session_id, prompt and expected_output_json' });
    }
    this.closeUpstream();
    this.init = {
      session_id: String(p.session_id),
      prompt: p.prompt,
      expected_output_json: p.expected_output_json,
      need_transcription: p.need_transcription ?? true,
    };
    this.everConnected = false;
    this.retries = 0;
    this.chunks = 0;
    await this.connectUpstream();
  }

  private async connectUpstream() {
    const base = originOf(this.env.AMBIENT_SERVER_URL!);
    const init = this.init!;
    const upstream = new Sio2Client(base, '/ambient', {
      // (Re)initialise on every connect with the same session_id, so a reconnect resumes the session.
      onConnect: () => {
        this.everConnected = true;
        this.retries = 0;
        console.log(`${this.tag} upstream connected, init session`);
        upstream.emit('init_ambient_session', { subscription_api_key: this.env.AMBIENT_SUBSCRIPTION_API_KEY, ...init });
      },
      onEvent: (event, data) => {
        if (event === 'error') {
          const message = parseError(data);
          console.warn(`${this.tag} upstream error: ${message}`);
          return this.send('ambient_error', { message });
        }
        if (event !== 'connected' && event !== 'output_json' && event !== 'connection_closed') return;
        console.log(`${this.tag} <- ${event}`);
        this.send(event, data);
        if (event === 'connection_closed') this.closeUpstream();
      },
      onError: (message) => this.send('ambient_error', { message }),
      onClose: (reason) => {
        console.log(`${this.tag} upstream ${reason}`);
        if (this.upstream !== upstream) return;
        if (!this.everConnected) {
          this.send('ambient_error', { message: `Ambient server unreachable: ${reason}` });
          return this.closeUpstream();
        }
        this.send('upstream_disconnected', { reason });
        this.scheduleReconnect();
      },
    });
    this.upstream = upstream;
    try {
      await upstream.connect();
    } catch (err) {
      if (this.upstream !== upstream) return;
      const message = err instanceof Error ? err.message : String(err);
      if (!this.everConnected) {
        this.send('ambient_error', { message: `Ambient server unreachable: ${message}` });
        this.closeUpstream();
      } else {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect() {
    if (!this.client || !this.init) return;
    if (++this.retries > MAX_UPSTREAM_RETRIES) {
      this.send('ambient_error', { message: 'Lost connection to the ambient server' });
      return this.closeUpstream();
    }
    setTimeout(() => {
      if (this.client && this.init && !this.upstream?.connected) void this.connectUpstream();
    }, RETRY_DELAY_MS);
  }

  private closeUpstream() {
    const u = this.upstream;
    this.upstream = null;
    u?.close();
  }
}

function originOf(url: string): string {
  const cleaned = url.trim().replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  try {
    const u = new URL(cleaned);
    return `${u.protocol}//${u.host}`;
  } catch {
    return cleaned.replace(/\/$/, '');
  }
}

/** Upstream errors arrive as a string, { message }, or ["error", { message }]. */
function parseError(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    const obj = data.find((d) => d && typeof d === 'object' && 'message' in d) as { message?: string } | undefined;
    if (obj?.message) return obj.message;
    const str = data.find((d) => typeof d === 'string' && d !== 'error');
    if (typeof str === 'string') return str;
  }
  if (data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string') {
    return (data as { message: string }).message;
  }
  return 'Unknown ambient server error';
}
