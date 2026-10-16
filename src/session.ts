/**
 * EventSession: one Durable Object per panel session (named by the session id).
 *
 *   panel ──WebSocket /v1/stream──► EventSession ──POST /v1/events (signed)──► Emitter
 *   panel ◄──── frames, in seq order ── EventSession ◄── POST /v1/emitter/callback/{route} ── Emitter
 *
 * It owns the socket (hibernatable: no cost while idle), every run's state and a short replay
 * buffer so a reconnecting panel can resume. All state lives in Durable Object storage because
 * memory is dropped when the object hibernates.
 *
 * Never log payloads or context (PHI): ids, types, sizes and outcomes only.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  CALLBACK_PATH_PREFIX,
  CLOSE_CODES,
  Envelope,
  FINAL_TYPES,
  LIMITS,
  PANEL_EVENT_TYPES,
  PING_FRAME,
  PONG_FRAME,
  PROTOCOL_VERSION,
  SessionEvents,
  USER_TURN_TYPES,
  checkUiPatch,
  checkUiTree,
  envelope,
  formatIssues,
  parsePayload,
  sessionIdFor,
  type DispatchRequest,
  type UiNode,
} from '@gooddoc/gd-contracts';
import type { Env } from './env';
import { readToken, type SessionClaims } from './tokens';
import { dispatch, emitterConfigured, makeRoute } from './emitter';

const AUTH_TIMEOUT_MS = 10_000;
/** A run waiting on the user ends after this long without activity. */
const USER_TURN_MAX_MS = 60 * 60 * 1000;

type RunStatus = 'open' | 'completed' | 'error' | 'cancelled';

interface RunState {
  runId: string;
  plugin: string;
  status: RunStatus;
  /** Highest seq delivered (−1 before the first frame). */
  lastSeq: number;
  /** Lowest seq still in the replay buffer. */
  bufFrom: number;
  bufBytes: number;
  createdAt: number;
  lastActivity: number;
  gotFirst: boolean;
  /** It's the user's turn: the idle timer is paused. */
  waiting: boolean;
  idleTimeoutSec: number;
  endedAt?: number;
  outcome?: string;
}

interface SessionInfo {
  sessionId: string;
  tenantId: string;
  origin: string;
  exp: number;
  publicOrigin: string;
  context: Record<string, unknown>;
  locale: string | null;
}

interface Attachment {
  authed: boolean;
  /** The session id the Worker routed this socket by (from ?sid=). */
  sessionId: string;
  connectedAt: number;
  publicOrigin: string;
}

type CallbackResult = { status: number; body: Record<string, unknown> };

const runKey = (runId: string) => `run:${runId}`;
const bufPrefix = (runId: string) => `buf:${runId}:`;
const bufKey = (runId: string, seq: number) => `${bufPrefix(runId)}${String(seq).padStart(9, '0')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

export class EventSession extends DurableObject<Env> {
  private runs = new Map<string, RunState>();
  private session: SessionInfo | null = null;
  private rate = { windowStart: 0, count: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alives are answered by the runtime without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
    ctx.blockConcurrencyWhile(async () => {
      this.session = (await ctx.storage.get<SessionInfo>('session')) ?? null;
      for (const [, run] of await ctx.storage.list<RunState>({ prefix: 'run:' })) this.runs.set(run.runId, run);
    });
  }

  // ── HTTP entry points (called by the Worker) ───────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect') return this.openSocket(request);
    if (url.pathname === '/callback' && request.method === 'POST') {
      const result = await this.callback(await request.text());
      return Response.json(result.body, { status: result.status });
    }
    return new Response('Not found', { status: 404 });
  }

  private async openSocket(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = {
      authed: false,
      sessionId: request.headers.get('X-GD-Session-Id') ?? '',
      connectedAt: now(),
      publicOrigin: request.headers.get('X-GD-Public-Origin') ?? new URL(request.url).origin,
    };
    server.serializeAttachment(attachment);
    this.send(server, 'ready', { protocol: PROTOCOL_VERSION });
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Panel socket ───────────────────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > LIMITS.frameBytes) return this.notify(ws, 'error', 'Frame too large or not text');
    if (!this.allowRate()) return ws.close(CLOSE_CODES.rateLimited, 'retry-after=5');

    let frame: { event?: unknown; data?: unknown };
    try {
      frame = JSON.parse(message);
    } catch {
      return this.notify(ws, 'error', 'Frame is not JSON');
    }
    const parsed = Envelope.safeParse(frame.data);
    if (!parsed.success || typeof frame.event !== 'string' || frame.event !== parsed.data.type) {
      return this.notify(ws, 'error', `Invalid frame: ${parsed.success ? 'event must equal data.type' : formatIssues(parsed.error)}`);
    }
    const env = parsed.data;
    const att = ws.deserializeAttachment() as Attachment;

    if (!att.authed) {
      if (env.type !== 'auth') return this.rejectAuth(ws, 'auth_required', 'Send auth first');
      return this.authenticate(ws, att, env.payload);
    }
    if (!this.session || this.session.exp <= now()) return this.rejectAuth(ws, 'token_expired', 'Session expired');

    const check = parsePayload(env.type, env.payload);
    if (!check.ok) return this.notify(ws, 'error', `Invalid ${env.type}: ${check.error}`);
    const payload = check.payload;

    switch (env.type) {
      case 'session.start': {
        const p = SessionEvents['session.start'].parse(payload);
        this.session = { ...this.session, context: p.context, locale: p.locale ?? null };
        await this.ctx.storage.put('session', this.session);
        return;
      }
      case 'run.resume':
        return this.resume(ws, payload.runId as string, payload.lastSeq as number);
      case 'plugin.invoke':
        return this.invoke(ws, { ...env, payload });
      case 'context.update': {
        this.session = { ...this.session, context: payload.context as Record<string, unknown> };
        await this.ctx.storage.put('session', this.session);
        // Every open run hears about it.
        for (const run of this.openRuns()) this.ctx.waitUntil(this.forward(run, { ...env, id: crypto.randomUUID(), runId: run.runId, payload }));
        return;
      }
      default:
        if (!(PANEL_EVENT_TYPES as string[]).includes(env.type)) return; // unknown: ignored
        return this.panelRunEvent(ws, { ...env, payload });
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closed');
    } catch {
      /* already closed */
    }
  }

  async webSocketError(): Promise<void> {
    /* the close handler runs next */
  }

  private async authenticate(ws: WebSocket, att: Attachment, payload: Record<string, unknown>) {
    const p = SessionEvents.auth.safeParse(payload);
    const claims = p.success && this.env.GD_TOKEN_SECRET ? await readToken(this.env.GD_TOKEN_SECRET, p.data.sessionToken) : null;
    if (!p.success || !claims) return this.rejectAuth(ws, 'invalid_token', 'Session token is invalid or expired');
    const sessionId = await sessionIdFor(p.data.sessionToken);
    if (sessionId !== att.sessionId) return this.rejectAuth(ws, 'wrong_session', 'Token does not match this session');

    // One live socket per session: a new one replaces the old.
    for (const other of this.ctx.getWebSockets()) if (other !== ws) other.close(CLOSE_CODES.replaced, 'replaced by a newer connection');

    ws.serializeAttachment({ ...att, authed: true } satisfies Attachment);
    this.session = {
      sessionId,
      tenantId: claims.tenantId,
      origin: claims.origin,
      exp: claims.exp,
      publicOrigin: this.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || att.publicOrigin,
      context: this.session?.context ?? {},
      locale: this.session?.locale ?? null,
    };
    await this.ctx.storage.put('session', this.session);
    this.send(ws, 'session.ready', {
      sessionId,
      serverTime: new Date().toISOString(),
      limits: { ...LIMITS },
      emitter: emitterConfigured(this.env),
    });
  }

  private rejectAuth(ws: WebSocket, code: string, message: string) {
    this.send(ws, 'auth_error', { code, message });
    ws.close(CLOSE_CODES.authFailed, message.slice(0, 120));
  }

  private allowRate(): boolean {
    const t = now();
    if (t - this.rate.windowStart >= 1000) this.rate = { windowStart: t, count: 0 };
    return ++this.rate.count <= LIMITS.panelEventsPerSecond;
  }

  // ── Runs: panel side ───────────────────────────────────────────────────────

  private openRuns(): RunState[] {
    return [...this.runs.values()].filter((r) => r.status === 'open');
  }

  private async invoke(ws: WebSocket, env: Envelope) {
    const runId = env.runId;
    if (!runId || !env.plugin) return this.notify(ws, 'error', 'plugin.invoke needs runId and plugin');
    if (this.runs.has(runId)) return this.notify(ws, 'error', `runId ${runId} was already used`);

    const run: RunState = {
      runId,
      plugin: env.plugin,
      status: 'open',
      lastSeq: -1,
      bufFrom: 0,
      bufBytes: 0,
      createdAt: now(),
      lastActivity: now(),
      gotFirst: false,
      waiting: false,
      idleTimeoutSec: LIMITS.idleTimeoutSec,
    };
    this.runs.set(runId, run);
    await this.saveRun(run);

    if (this.openRuns().length > LIMITS.openRunsPerSession) {
      return this.endRun(run, 'too_many_runs', `At most ${LIMITS.openRunsPerSession} plugins can run at once. Close one and try again.`, true);
    }
    if (!emitterConfigured(this.env)) {
      return this.endRun(run, 'emitter_not_configured', 'Plugins are not available: the Emitter is not configured.', false);
    }
    await this.scheduleAlarm();
    await this.forward(run, env);
  }

  private async panelRunEvent(ws: WebSocket, env: Envelope) {
    const run = env.runId ? this.runs.get(env.runId) : undefined;
    if (!run) return this.notify(ws, 'warning', 'That plugin run is no longer available');
    if (run.status !== 'open') return this.notify(ws, 'warning', 'That plugin run has ended');

    if (env.type === 'run.cancel') {
      await this.endRun(run, 'cancelled', 'Cancelled', false, 'cancelled');
      // Best effort: the Emitter also learns from 410 on its next callback.
      this.ctx.waitUntil(this.forward(run, env, { final: true }));
      return;
    }
    // The user answered: it's the Emitter's turn again.
    run.waiting = false;
    run.lastActivity = now();
    await this.saveRun(run);
    await this.scheduleAlarm();
    await this.forward(run, env);
  }

  /** Dispatch a panel event for a run; on failure, end the run with a user-safe error. */
  private async forward(run: RunState, event: Envelope, opts: { final?: boolean } = {}) {
    const s = this.session!;
    const request: DispatchRequest = {
      event: { ...event, plugin: event.plugin ?? run.plugin },
      callback: {
        url: `${s.publicOrigin}${CALLBACK_PATH_PREFIX}${await makeRoute(this.env.GD_TOKEN_SECRET!, s.sessionId)}`,
        expiresAt: new Date(s.exp).toISOString(),
      },
      session: { id: s.sessionId, tenantId: s.tenantId, userId: null, keyId: null, origin: s.origin, locale: s.locale },
      context: s.context,
    };
    const result = await dispatch(this.env, request);
    if (result.ok || opts.final) return;
    console.warn(`dispatch run=${run.runId} type=${event.type} -> ${result.status} ${result.code}`);
    const current = this.runs.get(run.runId);
    if (!current || current.status !== 'open') return;
    if (result.code === 'unknown_plugin') return this.endRun(current, 'unknown_plugin', 'This plugin is not available.', false);
    if (result.code === 'run_closed') return this.endRun(current, 'run_closed', 'This plugin run has already ended.', false);
    if (result.status >= 400 && result.status < 500) return this.endRun(current, 'invalid_frame', 'The request could not be processed.', false);
    return this.endRun(current, 'emitter_unavailable', 'The plugin service is not responding. Try again shortly.', true);
  }

  private async resume(ws: WebSocket, runId: string, lastSeq: number) {
    const run = this.runs.get(runId);
    if (!run || lastSeq + 1 < run.bufFrom) {
      return this.send(ws, 'run.error', { code: 'resume_expired', message: 'This plugin run can no longer be resumed.', retryable: false }, { runId });
    }
    const frames = await this.ctx.storage.list<string>({ start: bufKey(runId, lastSeq + 1), prefix: bufPrefix(runId) });
    for (const [, raw] of frames) ws.send(raw);
  }

  // ── Runs: Emitter side (callback) ──────────────────────────────────────────

  async callback(rawBody: string): Promise<CallbackResult> {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: { code: 'invalid_json', message: 'Body is not JSON' } } };
    }
    const frames = Array.isArray(body) ? body : [body];
    if (frames.length === 0 || frames.length > LIMITS.framesPerCallback) {
      return { status: 400, body: { error: { code: 'too_many_frames', message: `1 to ${LIMITS.framesPerCallback} frames per request` } } };
    }
    let accepted = 0;
    let duplicates = 0;
    for (let i = 0; i < frames.length; i++) {
      const r = await this.acceptFrame(frames[i], Array.isArray(body) ? `[${i}]` : '');
      if (r === 'accepted') accepted++;
      else if (r === 'duplicate') duplicates++;
      else return { status: r.status, body: { ...r.body, accepted } };
    }
    await this.scheduleAlarm();
    if (!Array.isArray(body) && duplicates === 1) return { status: 200, body: { duplicate: true } };
    return { status: 202, body: { accepted, duplicates } };
  }

  private async acceptFrame(raw: unknown, path: string): Promise<'accepted' | 'duplicate' | CallbackResult> {
    const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): CallbackResult => ({
      status,
      body: { error: { code, message, path: path || undefined, ...extra } },
    });
    const size = JSON.stringify(raw ?? null).length;
    if (size > LIMITS.frameBytes) return fail(413, 'frame_too_large', `Frame is ${size} bytes; max ${LIMITS.frameBytes}`);

    const parsed = Envelope.safeParse(raw);
    if (!parsed.success) return fail(400, 'invalid_frame', formatIssues(parsed.error));
    const env = parsed.data;
    if (!env.runId || env.seq === undefined) return fail(400, 'invalid_frame', 'runId and seq are required');
    const check = parsePayload(env.type, env.payload);
    if (!check.ok) return fail(400, 'invalid_frame', `${env.type}: ${check.error}`);
    if (env.type === 'ui.render') {
      const errors = checkUiTree(check.payload.tree as UiNode);
      if (errors.length) return fail(400, 'invalid_frame', `ui.render: ${errors.slice(0, 5).join('; ')}`);
    }
    if (env.type === 'ui.patch') {
      const errors = checkUiPatch(check.payload.ops as Array<{ nodeId: string; set: Record<string, unknown> }>);
      if (errors.length) return fail(400, 'invalid_frame', `ui.patch: ${errors.slice(0, 5).join('; ')}`);
    }

    let run = this.runs.get(env.runId);
    if (!run) return fail(404, 'unknown_run', 'No such run in this session');
    if (env.seq <= run.lastSeq) return 'duplicate';
    if (run.status !== 'open') {
      return fail(410, run.status === 'cancelled' ? 'run_cancelled' : 'run_expired', `Run is ${run.status}`);
    }

    // Wait briefly for an earlier frame that's still in flight.
    if (env.seq > run.lastSeq + 1) {
      const until = now() + LIMITS.seqGapWaitMs;
      while (now() < until) {
        await sleep(50);
        run = this.runs.get(env.runId)!;
        if (env.seq <= run.lastSeq) return 'duplicate';
        if (run.status !== 'open') return fail(410, run.status === 'cancelled' ? 'run_cancelled' : 'run_expired', `Run is ${run.status}`);
        if (env.seq === run.lastSeq + 1) break;
      }
      if (env.seq > run.lastSeq + 1) return fail(409, 'seq_gap', `Expected seq ${run.lastSeq + 1}`, { lastSeq: run.lastSeq });
    }

    const frame: Envelope = { ...env, payload: check.payload, plugin: env.plugin ?? run.plugin };

    // host.call needs per-plugin permissions (plugin manifests, phase 5). Until then gd-api answers
    // the Emitter itself, so the run carries on, and the panel never sees the call.
    if (env.type === 'host.call') {
      run.lastSeq = env.seq;
      run.gotFirst = true;
      run.lastActivity = now();
      await this.saveRun(run);
      const answer = envelope('host.result', { ok: false, error: { code: 'not_supported', message: 'host.call is not enabled yet' } }, { runId: run.runId, replyTo: env.id, plugin: run.plugin });
      this.ctx.waitUntil(this.forward(run, answer));
      return 'accepted';
    }

    await this.deliver(run, frame);
    return 'accepted';
  }

  /** Record a frame as the run's next seq, buffer it for resume, and push it to the panel. */
  private async deliver(run: RunState, frame: Envelope) {
    // In-memory first (before any await) so concurrent callbacks see the new seq.
    run.lastSeq = frame.seq!;
    run.gotFirst = true;
    run.lastActivity = now();
    run.waiting = USER_TURN_TYPES.includes(frame.type);
    if (FINAL_TYPES.includes(frame.type)) {
      run.status = frame.type === 'run.completed' ? 'completed' : run.status === 'open' ? 'error' : run.status;
      run.endedAt = now();
      run.outcome ??= frame.type === 'run.completed' ? 'completed' : String(frame.payload.code ?? 'error');
    }

    const raw = JSON.stringify({ event: frame.type, data: frame });
    run.bufBytes += raw.length;
    const puts: Record<string, unknown> = { [bufKey(run.runId, frame.seq!)]: raw };
    // Trim the oldest buffered frames beyond the size cap.
    const evict: string[] = [];
    if (run.bufBytes > LIMITS.replayBufferBytes) {
      const old = await this.ctx.storage.list<string>({ prefix: bufPrefix(run.runId), limit: 64 });
      for (const [key, value] of old) {
        if (run.bufBytes <= LIMITS.replayBufferBytes) break;
        evict.push(key);
        run.bufBytes -= value.length;
        run.bufFrom = Number(key.slice(-9)) + 1;
      }
    }
    puts[runKey(run.runId)] = run;
    await this.ctx.storage.put(puts);
    if (evict.length) await this.ctx.storage.delete(evict);

    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment).authed) {
        try {
          ws.send(raw);
        } catch {
          /* socket closing; the panel resumes from the buffer */
        }
      }
    }
    if (run.endedAt) this.audit(run);
  }

  /** gd-api ends a run itself (timeout, cancel, errors): a final run.error with the next seq. */
  private async endRun(run: RunState, code: string, message: string, retryable: boolean, status: RunStatus = 'error') {
    if (run.status !== 'open') return;
    run.status = status;
    run.outcome = code;
    await this.deliver(run, envelope('run.error', { code, message, retryable }, { runId: run.runId, seq: run.lastSeq + 1, plugin: run.plugin }));
    await this.scheduleAlarm();
  }

  private audit(run: RunState) {
    console.log(
      JSON.stringify({
        audit: 'run',
        sessionId: this.session?.sessionId,
        tenantId: this.session?.tenantId,
        plugin: run.plugin,
        runId: run.runId,
        startedAt: new Date(run.createdAt).toISOString(),
        endedAt: new Date(run.endedAt ?? now()).toISOString(),
        outcome: run.outcome,
        frames: run.lastSeq + 1,
      }),
    );
  }

  // ── Timers ─────────────────────────────────────────────────────────────────

  private deadline(run: RunState): number {
    if (run.status !== 'open') return (run.endedAt ?? now()) + LIMITS.replayBufferMs; // purge time
    if (!run.gotFirst) return run.createdAt + LIMITS.firstFrameTimeoutMs;
    if (run.waiting) return run.lastActivity + USER_TURN_MAX_MS;
    return run.lastActivity + run.idleTimeoutSec * 1000;
  }

  private async scheduleAlarm() {
    let next = Infinity;
    for (const run of this.runs.values()) next = Math.min(next, this.deadline(run));
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (!att.authed) next = Math.min(next, att.connectedAt + AUTH_TIMEOUT_MS);
    }
    if (next === Infinity) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current || current < now()) await this.ctx.storage.setAlarm(Math.max(next, now() + 10));
  }

  async alarm(): Promise<void> {
    const t = now();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (!att.authed && t >= att.connectedAt + AUTH_TIMEOUT_MS) this.rejectAuth(ws, 'auth_timeout', 'Authentication timed out');
    }
    for (const run of [...this.runs.values()]) {
      if (t < this.deadline(run)) continue;
      if (run.status === 'open') {
        await this.endRun(run, 'timeout', run.gotFirst ? 'The plugin stopped responding.' : 'The plugin did not respond.', true);
      } else {
        // Purge: the replay window has passed.
        this.runs.delete(run.runId);
        const keys = [...(await this.ctx.storage.list({ prefix: bufPrefix(run.runId) })).keys(), runKey(run.runId)];
        for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
      }
    }
    await this.scheduleAlarm();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private send(ws: WebSocket, type: string, payload: Record<string, unknown>, extra: { runId?: string } = {}) {
    try {
      ws.send(JSON.stringify({ event: type, data: envelope(type, payload, extra) }));
    } catch {
      /* closed */
    }
  }

  private notify(ws: WebSocket, level: 'info' | 'warning' | 'error', text: string) {
    this.send(ws, 'notify', { level, text: text.slice(0, 500) });
  }

  private async saveRun(run: RunState) {
    await this.ctx.storage.put(runKey(run.runId), run);
  }
}
