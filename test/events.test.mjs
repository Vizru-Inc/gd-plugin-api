/**
 * End-to-end tests for plugin events: panel socket ⇄ gd-api (wrangler dev) ⇄ mock Emitter.
 *
 *   terminal 1: pnpm mock-emitter
 *   terminal 2: pnpm dev            (.dev.vars: EMITTER_URL=http://localhost:4200 + the two dev secrets)
 *   terminal 3: pnpm test:events
 *
 * Env: GD_API (http://localhost:4000), ORIGIN (http://localhost:5173), EMITTER_CALLBACK_SECRET (dev-callback-secret).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const API = process.env.GD_API ?? 'http://localhost:4000';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
const CALLBACK_SECRET = process.env.EMITTER_CALLBACK_SECRET ?? 'dev-callback-secret';
const KEY = process.env.GD_KEY ?? 'gd_test_demo1234';
const EMITTER = process.env.EMITTER ?? 'http://localhost:4200';

const sessionIdFor = (token) => createHash('sha256').update(token).digest('base64url').slice(0, 32);
const env = (type, payload, extra = {}) => ({ v: 1, id: randomUUID(), ts: new Date().toISOString(), type, payload, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newToken() {
  const res = await fetch(`${API}/v1/keys/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ apiKey: KEY }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.sessionToken;
}

/** A panel-like client: connects, authenticates, records every frame. */
async function connect(token, { auth = true, start = true, sid } = {}) {
  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/v1/stream?sid=${sid ?? sessionIdFor(token)}`);
  const frames = [];
  const waiters = new Set();
  let closed = null;
  ws.addEventListener('message', (e) => {
    const f = JSON.parse(e.data);
    frames.push(f);
    for (const w of waiters) w();
  });
  ws.addEventListener('close', (e) => {
    closed = { code: e.code, reason: e.reason };
    for (const w of waiters) w();
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const c = {
    ws,
    frames,
    get closed() {
      return closed;
    },
    send: (type, payload, extra) => ws.send(JSON.stringify({ event: type, data: env(type, payload, extra) })),
    waitFor(pred, ms = 8000, what = 'frame') {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = frames.find(pred);
          if (hit) return done(resolve, hit);
          if (closed && pred === CLOSED) return done(resolve, closed);
        };
        const timer = setTimeout(() => done(reject, new Error(`timed out waiting for ${what}; got ${frames.map((f) => f.event).join(', ')}`)), ms);
        const done = (fn, v) => {
          clearTimeout(timer);
          waiters.delete(check);
          fn(v);
        };
        waiters.add(check);
        check();
      });
    },
    runFrames: (runId) => frames.filter((f) => f.data?.runId === runId && typeof f.data.seq === 'number'),
    close: () => ws.close(),
  };
  await c.waitFor((f) => f.event === 'ready', 5000, 'ready');
  if (auth) {
    c.send('auth', { sessionToken: token });
    await c.waitFor((f) => f.event === 'session.ready' || f.event === 'auth_error', 5000, 'session.ready');
    if (start) c.send('session.start', { context: { patient: { id: 'DEN-88210', name: 'Maya Patel', age: 34 } }, locale: 'en-IN' });
  }
  return c;
}
const CLOSED = () => false;

function invoke(c, plugin, input = {}) {
  const runId = randomUUID();
  c.send('plugin.invoke', { action: 'open', input }, { runId, plugin });
  return runId;
}
const finalOf = (c, runId, ms = 10000) => c.waitFor((f) => f.data?.runId === runId && (f.event === 'run.completed' || f.event === 'run.error'), ms, `final frame of ${runId.slice(0, 8)}`);

function assertContiguous(c, runId) {
  const seqs = c.runFrames(runId).map((f) => f.data.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i), `seq should be 0..n in order, got ${seqs}`);
}

async function signedCallback(path, body, { secret = CALLBACK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GD-Timestamp': String(ts), 'X-GD-Signature': `sha256=${sig}` }, body: raw });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('rejects a bad token with auth_error and close 4401', async () => {
  const token = await newToken();
  const c = await connect(token, { auth: false });
  c.send('auth', { sessionToken: token.slice(0, -2) + 'xx' });
  const err = await c.waitFor((f) => f.event === 'auth_error');
  assert.equal(err.data.payload.code, 'invalid_token');
  await c.waitFor(CLOSED, 3000, 'close');
  assert.equal(c.closed.code, 4401);
});

test('rejects a token that does not match the sid', async () => {
  const [a, b] = [await newToken(), await newToken()];
  const c = await connect(a, { auth: false, sid: sessionIdFor(b) });
  c.send('auth', { sessionToken: a });
  assert.equal((await c.waitFor((f) => f.event === 'auth_error')).data.payload.code, 'wrong_session');
});

test('session.ready reports the emitter and limits', async () => {
  const c = await connect(await newToken());
  const ready = c.frames.find((f) => f.event === 'session.ready').data.payload;
  assert.equal(ready.emitter, true);
  assert.equal(ready.limits.frameBytes, 256 * 1024);
  c.close();
});

test('chat: streams a greeting, answers a message, cancels', async () => {
  const c = await connect(await newToken());
  const runId = invoke(c, 'demo.chat');
  const first = await c.waitFor((f) => f.data?.runId === runId && f.event === 'message.done');
  assert.match(first.data.payload.text, /Maya Patel/);
  assert.ok(c.runFrames(runId).some((f) => f.event === 'message.delta'), 'streams deltas');
  assert.equal(c.runFrames(runId)[0].event, 'run.accepted');

  c.send('message.send', { text: 'hello there' }, { runId });
  const reply = await c.waitFor((f) => f.data?.runId === runId && f.event === 'message.done' && /hello there/.test(f.data.payload.text));
  assert.ok(reply);

  c.send('run.cancel', {}, { runId });
  const fin = await finalOf(c, runId);
  assert.equal(fin.data.payload.code, 'cancelled');
  assertContiguous(c, runId);

  c.send('message.send', { text: 'too late' }, { runId });
  const warn = await c.waitFor((f) => f.event === 'notify' && /ended/.test(f.data.payload.text));
  assert.equal(warn.data.payload.level, 'warning');
  c.close();
});

test('action: progress then completed, seq contiguous', async () => {
  const c = await connect(await newToken());
  const runId = invoke(c, 'demo.slow', { steps: 3, stepMs: 150 });
  const fin = await finalOf(c, runId);
  assert.equal(fin.event, 'run.completed');
  assert.equal(c.runFrames(runId).filter((f) => f.event === 'run.progress').length, 3);
  assertContiguous(c, runId);
  c.close();
});

test('out-of-order callbacks are delivered in seq order', async () => {
  const c = await connect(await newToken());
  const runId = invoke(c, 'demo.slow', { steps: 1, stepMs: 50, shuffle: true });
  await finalOf(c, runId);
  const types = c.runFrames(runId).map((f) => f.event);
  assert.deepEqual(types.slice(-2), ['message.done', 'run.completed']);
  assertContiguous(c, runId);
  c.close();
});

test('emitter run.error and unknown plugin both end the run', async () => {
  const c = await connect(await newToken());
  const a = invoke(c, 'demo.error');
  assert.equal((await finalOf(c, a)).data.payload.code, 'demo_failure');
  const b = invoke(c, 'no.such.plugin');
  assert.equal((await finalOf(c, b)).data.payload.code, 'unknown_plugin');
  c.close();
});

test('described UI: ui.render reaches the panel, submit completes the run', async () => {
  const c = await connect(await newToken());
  const runId = invoke(c, 'demo.form');
  const ui = await c.waitFor((f) => f.data?.runId === runId && f.event === 'ui.render');
  assert.equal(ui.data.payload.surface, 'view');
  assert.ok(ui.data.payload.tree.children.some((n) => n.id === 'panel'));
  // Server-side validation answers with a patch on the same uiId.
  c.send('ui.submit', { uiId: 'order', values: { panel: 'hba1c', collect: '2020-01-01' } }, { runId });
  const patch = await c.waitFor((f) => f.data?.runId === runId && f.event === 'ui.patch');
  assert.deepEqual(patch.data.payload.ops[0], { nodeId: 'collect', set: { error: 'Pick today or a later date' } });
  c.send('ui.submit', { uiId: 'order', values: { panel: 'hba1c', fasting: true, collect: new Date().toISOString().slice(0, 10) } }, { runId });
  assert.equal((await finalOf(c, runId)).event, 'run.completed');
  assert.ok(c.runFrames(runId).some((f) => f.event === 'ui.render' && f.data.payload.uiId === 'placed'));
  c.close();
});

test('ui.patch is validated: no children, https only', async () => {
  const c = await connect(await newToken());
  const runId = invoke(c, 'demo.slow', { silent: true });
  await c.waitFor((f) => f.data?.runId === runId && f.event === 'run.accepted');
  const path = new URL((await (await fetch(`${EMITTER}/debug/runs/${runId}`)).json()).callbackUrl).pathname;
  const kids = await signedCallback(path, env('ui.patch', { uiId: 'u', ops: [{ nodeId: 'a', set: { children: [] } }] }, { runId, seq: 1 }));
  assert.match(kids.body.error.message, /props only/);
  const http = await signedCallback(path, env('ui.patch', { uiId: 'u', ops: [{ nodeId: 'a', set: { href: 'javascript:alert(1)' } }] }, { runId, seq: 1 }));
  assert.match(http.body.error.message, /https/);
  c.send('run.cancel', {}, { runId });
  await finalOf(c, runId);
  c.close();
});

test('host.call is answered by gd-api (not yet enabled) and never reaches the panel', async () => {
  const c = await connect(await newToken());
  const runId = invoke(c, 'demo.host');
  await finalOf(c, runId);
  assert.ok(!c.frames.some((f) => f.event === 'host.call'));
  const done = c.runFrames(runId).find((f) => f.event === 'message.done');
  assert.match(done.data.payload.text, /not_supported/);
  // seq has a hole where host.call was: the panel sees 0,1(skipped),2,… — so check only order.
  const seqs = c.runFrames(runId).map((f) => f.data.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  c.close();
});

test('resume after reconnect replays missed frames', async () => {
  const token = await newToken();
  const a = await connect(token);
  const runId = invoke(a, 'demo.slow', { steps: 4, stepMs: 400 });
  await a.waitFor((f) => f.data?.runId === runId && f.event === 'run.progress');
  const lastSeq = Math.max(...a.runFrames(runId).map((f) => f.data.seq));
  a.close();
  await sleep(1500); // frames keep arriving at gd-api while we're away

  const b = await connect(token);
  b.send('run.resume', { runId, lastSeq });
  await finalOf(b, runId);
  const seqs = b.runFrames(runId).map((f) => f.data.seq);
  assert.equal(seqs[0], lastSeq + 1, 'replay starts right after lastSeq');
  assert.deepEqual(seqs, seqs.map((_, i) => lastSeq + 1 + i));
  b.close();
});

test('a second socket for the same session replaces the first (4409)', async () => {
  const token = await newToken();
  const a = await connect(token);
  const b = await connect(token);
  await a.waitFor(CLOSED, 3000, 'close');
  assert.equal(a.closed.code, 4409);
  b.close();
});

test('too many open runs: the 6th fails', async () => {
  const c = await connect(await newToken());
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(invoke(c, 'demo.slow', { silent: true }));
  const fin = await finalOf(c, ids[5]);
  assert.equal(fin.data.payload.code, 'too_many_runs');
  for (const id of ids.slice(0, 5)) c.send('run.cancel', {}, { runId: id });
  for (const id of ids.slice(0, 5)) assert.equal((await finalOf(c, id)).data.payload.code, 'cancelled');
  c.close();
});

test('callback endpoint: signature, route and frame checks', async () => {
  const token = await newToken();
  const c = await connect(token);
  const runId = invoke(c, 'demo.slow', { silent: true });
  await c.waitFor((f) => f.data?.runId === runId && f.event === 'run.accepted');
  const debug = await (await fetch(`${EMITTER}/debug/runs/${runId}`)).json();
  const path = new URL(debug.callbackUrl).pathname;
  const frame = (seq, type = 'run.progress', payload = { label: 'x' }) => env(type, payload, { runId, seq });

  const bogus = '/v1/emitter/callback/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  assert.equal((await signedCallback(bogus, frame(1), { secret: 'wrong' })).status, 401);
  assert.equal((await signedCallback(bogus, frame(1), { ts: Math.floor(Date.now() / 1000) - 3600 })).body.error.code, 'stale_timestamp');
  assert.equal((await signedCallback(bogus, frame(1))).body.error.code, 'unknown_route');

  // Real route: frame checks.
  const bad = await signedCallback(path, frame(1, 'message.delta', { text: 'no id' }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /messageId/);
  assert.equal((await signedCallback(path, env('run.progress', { label: 'x' }, { runId: randomUUID(), seq: 0 }))).body.error.code, 'unknown_run');
  const t0 = Date.now();
  const gap = await signedCallback(path, frame(5));
  assert.equal(gap.status, 409);
  assert.deepEqual([gap.body.error.code, gap.body.error.lastSeq], ['seq_gap', 0]);
  assert.ok(Date.now() - t0 >= 1900, 'held ~2 s for the gap');
  assert.deepEqual((await signedCallback(path, frame(0))).body, { duplicate: true });
  const batch = await signedCallback(path, [frame(1), frame(2)]);
  assert.deepEqual([batch.status, batch.body.accepted], [202, 2]);
  await c.waitFor((f) => f.data?.runId === runId && f.data.seq === 2);
  const big = await signedCallback(path, frame(3, 'run.progress', { label: 'x'.repeat(300 * 1024) }));
  assert.equal(big.status, 413);
  const badUi = await signedCallback(path, frame(3, 'ui.render', { uiId: 'u', surface: 'view', schema: 1, tree: { id: 'a', type: 'image', props: { src: 'http://insecure' } } }));
  assert.match(badUi.body.error.message, /https/);

  c.send('run.cancel', {}, { runId });
  await finalOf(c, runId);
  const gone = await signedCallback(path, frame(4));
  assert.deepEqual([gone.status, gone.body.error.code], [410, 'run_cancelled']);
  c.close();
});

test('first-frame timeout: a silent Emitter ends the run after ~15 s', { timeout: 30000 }, async () => {
  const c = await connect(await newToken());
  const t0 = Date.now();
  const runId = invoke(c, 'demo.slow', { noAck: true });
  const fin = await finalOf(c, runId, 25000);
  assert.equal(fin.data.payload.code, 'timeout');
  assert.ok(Date.now() - t0 >= 14000, `took ${Date.now() - t0} ms`);
  c.close();
});
