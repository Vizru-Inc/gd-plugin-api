#!/usr/bin/env node
/**
 * Mock Emitter for local development and tests. Implements the Emitter side of the contract
 * (@gooddoc/gd-contracts) with plain Node, the way another stack would:
 *
 *   POST /v1/events    signed dispatch from gd-api → 202, then output via signed callbacks
 *   GET  /v1/plugins   the plugin catalog
 *
 * Demo plugins:
 *   demo.chat   chat: greets with the patient from context, answers every message (streams text)
 *   demo.slow   action: 5 progress steps, then a result. input: { steps, silent, noAck, shuffle }
 *   demo.error  action: fails with run.error
 *   demo.form   view: lab order form (select, chips, date, checkbox, text); server-side validation via ui.patch
 *   demo.grid   view: lab results grid (sort, multi-select, badges), a details sheet, live ui.patch, toast
 *   demo.host   action: asks the host app for data with host.call
 *
 * Env: PORT (4200), EMITTER_DISPATCH_SECRET, EMITTER_CALLBACK_SECRET (same values as gd-api's .dev.vars).
 */
import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4200);
const DISPATCH_SECRET = process.env.EMITTER_DISPATCH_SECRET ?? 'dev-dispatch-secret';
const CALLBACK_SECRET = process.env.EMITTER_CALLBACK_SECRET ?? 'dev-callback-secret';
const FLUSH_MS = 150;

const PLUGINS = [
  { id: 'demo.chat', version: '0.1.0', name: 'Assistant (demo)', description: 'Chat that knows the patient in context', icon: 'message-square', entry: 'chat', ui: { tier: 1 } },
  { id: 'demo.slow', version: '0.1.0', name: 'Long task (demo)', description: 'Shows progress, then a result', icon: 'timer', entry: 'action', ui: { tier: 1 } },
  { id: 'demo.error', version: '0.1.0', name: 'Failing plugin (demo)', icon: 'triangle-alert', entry: 'action', ui: { tier: 1 } },
  { id: 'demo.form', version: '0.1.0', name: 'Order labs (demo)', description: 'Form-first plugin, no chat', icon: 'flask-conical', entry: 'view', showWhen: { context: ['patient'] }, permissions: { host: [], writes: true }, ui: { tier: 2 } },
  { id: 'demo.grid', version: '0.1.0', name: 'Lab results (demo)', description: 'Data grid with selection', icon: 'clipboard-list', entry: 'view', showWhen: { context: ['patient'] }, ui: { tier: 2 } },
  { id: 'demo.host', version: '0.1.0', name: 'Recent activity (demo)', icon: 'history', entry: 'action', permissions: { host: ['host.getRecentActivity'], writes: false }, ui: { tier: 1 } },
];

// ── signing (same rules as the contract's README) ─────────────────────────────

const hmac = (secret, ts, body) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

function verify(req, body) {
  const ts = req.headers['x-gd-timestamp'];
  const sig = String(req.headers['x-gd-signature'] ?? '').replace(/^sha256=/, '');
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = Buffer.from(hmac(DISPATCH_SECRET, ts, body), 'hex');
  const got = Buffer.from(sig, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ── runs: per-run seq, batching, retries ──────────────────────────────────────

const runs = new Map(); // runId → { seq, queue, sent, callbackUrl, stopped, flushing, plugin, context }
const seenEvents = new Set();

function getRun(runId, callbackUrl, plugin) {
  let run = runs.get(runId);
  if (!run) {
    run = { runId, seq: 0, queue: [], sent: [], callbackUrl, stopped: false, flushing: false, plugin, timer: null, createdAt: Date.now() };
    runs.set(runId, run);
  }
  run.callbackUrl = callbackUrl;
  return run;
}

function emit(run, type, payload, extra = {}) {
  if (run.stopped) return;
  run.queue.push({ v: 1, id: randomUUID(), runId: run.runId, seq: run.seq++, type, ts: new Date().toISOString(), plugin: run.plugin, payload, ...extra });
  run.timer ??= setTimeout(() => flush(run), FLUSH_MS);
}

async function post(url, frames) {
  const body = JSON.stringify(frames.length === 1 ? frames[0] : frames);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GD-Timestamp': ts, 'X-GD-Signature': `sha256=${hmac(CALLBACK_SECRET, ts, body)}` },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function flush(run, attempt = 0) {
  run.timer = null;
  if (run.flushing || run.stopped || !run.queue.length) return;
  run.flushing = true;
  const frames = run.queue.splice(0, 100);
  try {
    const r = await post(run.callbackUrl, frames);
    log(`callback ${run.runId.slice(0, 8)} seq ${frames[0].seq}..${frames.at(-1).seq} → ${r.status}`);
    if (r.status === 202 || r.status === 200) {
      run.sent.push(...frames);
    } else if (r.status === 410 || r.status === 404) {
      run.stopped = true; // cancelled / expired / session gone: stop work
    } else if (r.status === 409) {
      const from = (r.body?.error?.lastSeq ?? -1) + 1;
      const resend = [...run.sent, ...frames].filter((f) => f.seq >= from);
      run.sent = run.sent.filter((f) => f.seq < from);
      run.queue.unshift(...resend.filter((f) => !run.queue.includes(f)));
    } else if (r.status === 429 || r.status >= 500) {
      run.queue.unshift(...frames);
      if (attempt < 5) {
        run.flushing = false;
        return void setTimeout(() => flush(run, attempt + 1), 500 * 2 ** attempt);
      }
      run.stopped = true;
    } else {
      console.error(`[mock-emitter] callback rejected ${r.status}`, JSON.stringify(r.body));
    }
  } catch (e) {
    run.queue.unshift(...frames);
    if (attempt < 5) {
      run.flushing = false;
      return void setTimeout(() => flush(run, attempt + 1), 500 * 2 ** attempt);
    }
    run.stopped = true;
  }
  run.flushing = false;
  if (run.queue.length && !run.stopped) run.timer ??= setTimeout(() => flush(run), FLUSH_MS);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stream(run, messageId, text) {
  const words = text.split(/(?<=\s)/);
  for (let i = 0; i < words.length; i += 3) {
    emit(run, 'message.delta', { messageId, text: words.slice(i, i + 3).join('') });
    await sleep(60);
  }
  emit(run, 'message.done', { messageId, text, format: 'markdown' });
}

// ── demo plugins ──────────────────────────────────────────────────────────────

const patientOf = (context) => context?.patient ?? null;

async function onInvoke(run, req) {
  const { input = {} } = req.event.payload;
  const patient = patientOf(req.context);
  switch (run.plugin) {
    case 'demo.chat': {
      emit(run, 'run.accepted', { title: 'Assistant', entry: 'chat' });
      emit(run, 'run.progress', { label: 'Reading the chart' });
      await sleep(300);
      const who = patient ? `**${patient.name ?? patient.id}**${patient.age ? ` (${patient.age})` : ''}` : 'no patient yet';
      return stream(run, `m-${randomUUID().slice(0, 8)}`, `Hi! I'm the demo assistant. In context: ${who}.\n\nAsk me anything and I'll echo it back, streamed word by word.`);
    }
    case 'demo.slow': {
      if (input.noAck) return; // nothing at all → first-frame timeout
      emit(run, 'run.accepted', { title: 'Long task', entry: 'action' });
      if (input.silent) return; // accepted, then silence → idle timeout
      const steps = Number(input.steps ?? 5);
      for (let i = 1; i <= steps; i++) {
        await sleep(Number(input.stepMs ?? 800));
        if (run.stopped) return;
        emit(run, 'run.progress', { label: `Step ${i} of ${steps}`, step: i, total: steps });
      }
      if (input.shuffle) {
        // Send the last two frames out of order to exercise gd-api's seq hold.
        const a = { v: 1, id: randomUUID(), runId: run.runId, seq: run.seq++, type: 'message.done', ts: new Date().toISOString(), payload: { messageId: 'r', text: 'Done (shuffled).', format: 'text' } };
        const b = { v: 1, id: randomUUID(), runId: run.runId, seq: run.seq++, type: 'run.completed', ts: new Date().toISOString(), payload: { summary: 'shuffled' } };
        await flush(run);
        const late = post(run.callbackUrl, b);
        await sleep(300);
        await post(run.callbackUrl, a);
        await late;
        return;
      }
      emit(run, 'message.done', { messageId: 'result', text: `Finished ${steps} steps.`, format: 'text' });
      return emit(run, 'run.completed', { summary: `Finished ${steps} steps` });
    }
    case 'demo.error':
      emit(run, 'run.accepted', { entry: 'action' });
      await sleep(200);
      return emit(run, 'run.error', { code: 'demo_failure', message: 'The demo plugin failed on purpose.', retryable: true });
    case 'demo.form':
      emit(run, 'run.accepted', { title: 'Order labs', entry: 'view' });
      return emit(run, 'ui.render', { uiId: 'order', surface: 'view', schema: 1, tree: orderForm(patient) });
    case 'demo.grid':
      emit(run, 'run.accepted', { title: 'Lab results', entry: 'view' });
      emit(run, 'run.progress', { label: 'Loading results' });
      await sleep(300);
      return emit(run, 'ui.render', { uiId: 'results', surface: 'view', schema: 1, tree: resultsGrid(patient) });
    case 'demo.host':
      emit(run, 'run.accepted', { entry: 'action' });
      return emit(run, 'host.call', { method: 'host.getRecentActivity', params: { patientId: patient?.id } });
    default:
      return;
  }
}

async function onRunEvent(run, req) {
  const { type, payload } = req.event;
  if (type === 'run.cancel') {
    run.stopped = true;
    return;
  }
  if (run.plugin === 'demo.chat' && type === 'message.send') {
    emit(run, 'run.progress', { label: 'Thinking' });
    await sleep(250);
    return stream(run, `m-${randomUUID().slice(0, 8)}`, `You said: “${payload.text}”.\n\nThis reply came from the mock Emitter through gd-api's callback.`);
  }
  if (run.plugin === 'demo.form' && type === 'ui.submit') return onOrderSubmit(run, payload.values ?? {});
  if (run.plugin === 'demo.grid') return onGridEvent(run, type, payload);
  if (run.plugin === 'demo.host' && type === 'host.result') {
    const text = payload.ok
      ? `Your app returned ${Array.isArray(payload.result) ? payload.result.length : 'some'} records.`
      : `Your app could not answer (${payload.error?.code ?? 'error'}).`;
    emit(run, 'message.done', { messageId: 'r', text, format: 'text' });
    return emit(run, 'run.completed', { summary: text });
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

const log = (...a) => process.env.MOCK_QUIET || console.log('[mock-emitter]', ...a);
const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/v1/plugins') return reply(res, 200, { plugins: PLUGINS });
  // Test hook (also used by the Postman collection): runs, newest first, with their callback URL and next seq.
  if (req.method === 'GET' && url.pathname === '/debug/runs') {
    const list = [...runs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ runId: r.runId, plugin: r.plugin, callbackUrl: r.callbackUrl, nextSeq: r.seq, stopped: r.stopped, startedAt: new Date(r.createdAt).toISOString() }));
    return reply(res, 200, { runs: list });
  }
  // Test hook: where a run's callbacks go, and its next seq.
  if (req.method === 'GET' && url.pathname.startsWith('/debug/runs/')) {
    const run = runs.get(url.pathname.slice('/debug/runs/'.length));
    return run ? reply(res, 200, { callbackUrl: run.callbackUrl, nextSeq: run.seq }) : reply(res, 404, {});
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/events') return reply(res, 404, { error: { code: 'not_found' } });

  let body = '';
  for await (const chunk of req) body += chunk;
  if (!verify(req, body)) return reply(res, 401, { error: { code: 'bad_signature' } });
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    return reply(res, 400, { error: { code: 'invalid_json' } });
  }
  const { event, callback } = request;
  if (seenEvents.has(event.id)) return reply(res, 200, { duplicate: true });
  seenEvents.add(event.id);

  if (event.type === 'plugin.invoke') {
    if (!PLUGINS.some((p) => p.id === event.plugin)) return reply(res, 404, { error: { code: 'unknown_plugin' } });
    reply(res, 202, { runId: event.runId });
    log(`invoke ${event.plugin} run=${event.runId.slice(0, 8)}`);
    return void onInvoke(getRun(event.runId, callback.url, event.plugin), request).catch((e) => console.error(e));
  }
  const run = runs.get(event.runId);
  if (!run) return reply(res, 409, { error: { code: 'run_closed' } });
  run.callbackUrl = callback.url;
  reply(res, 202, { runId: event.runId });
  log(`${event.type} run=${event.runId.slice(0, 8)}`);
  void onRunEvent(run, request).catch((e) => console.error(e));
}).listen(PORT, () => console.log(`[mock-emitter] listening on http://localhost:${PORT}`));

// ── described-UI demos ────────────────────────────────────────────────────────

const PANELS = [
  { value: 'cbc', label: 'CBC' },
  { value: 'lipid', label: 'Lipid panel' },
  { value: 'hba1c', label: 'HbA1c' },
  { value: 'cmp', label: 'Comprehensive metabolic panel' },
];
const today = () => new Date().toISOString().slice(0, 10);

function orderForm(patient) {
  return {
    id: 'root', type: 'stack', children: [
      { id: 'who', type: 'kv', props: { columns: 2, items: [{ label: 'Patient', value: patient?.name ?? '—' }, { label: 'ID', value: patient?.id ?? '—' }] } },
      { id: 'panel', type: 'select', props: { label: 'Panel', required: true, options: PANELS } },
      { id: 'addons', type: 'multiSelect', props: { label: 'Add-ons', options: [{ value: 'vitd', label: 'Vitamin D' }, { value: 'tsh', label: 'TSH' }, { value: 'ferritin', label: 'Ferritin' }] } },
      { id: 'row1', type: 'row', props: { gap: 'md' }, children: [
        { id: 'collect', type: 'date', props: { label: 'Collect on', required: true, min: today(), value: today() } },
        { id: 'priority', type: 'select', props: { label: 'Priority', value: 'routine', options: [{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' }] } },
      ] },
      { id: 'fasting', type: 'checkbox', props: { label: 'Patient should fast for 8 hours' } },
      { id: 'note', type: 'textArea', props: { label: 'Note to lab', placeholder: 'Optional', rows: 2, maxLength: 500 } },
      { id: 'actions', type: 'row', props: { align: 'end' }, children: [
        { id: 'submit', type: 'button', props: { label: 'Place order', submit: true, style: 'primary' } },
      ] },
    ],
  };
}

async function onOrderSubmit(run, v) {
  // Server-side validation: answer the same uiId with a patch, which also unlocks the form.
  if (!v.collect || v.collect < today()) {
    return emit(run, 'ui.patch', { uiId: 'order', ops: [{ nodeId: 'collect', set: { error: 'Pick today or a later date' } }] });
  }
  emit(run, 'ui.patch', { uiId: 'order', ops: [{ nodeId: 'collect', set: { error: '' } }, { nodeId: 'submit', set: { label: 'Order placed', disabled: true } }] });
  emit(run, 'run.progress', { label: 'Placing the order' });
  await sleep(500);
  const panel = PANELS.find((p) => p.value === v.panel)?.label ?? String(v.panel);
  const orderId = `LAB-${Math.floor(100000 + Math.random() * 899999)}`;
  emit(run, 'ui.render', {
    uiId: 'placed', surface: 'inline', schema: 1,
    tree: { id: 'card', type: 'card', props: { title: 'Order placed', subtitle: orderId, tone: 'success' }, children: [
      { id: 'kv', type: 'kv', props: { items: [
        { label: 'Panel', value: panel },
        { label: 'Add-ons', value: (v.addons ?? []).length ? v.addons.join(', ') : 'None' },
        { label: 'Collect on', value: v.collect },
        { label: 'Priority', value: v.priority === 'urgent' ? 'Urgent' : 'Routine' },
        { label: 'Fasting', value: v.fasting ? 'Yes, 8 hours' : 'No' },
      ] } },
    ] },
  });
  return emit(run, 'run.completed', { result: { orderId }, summary: `${panel} ordered (${orderId})` });
}

const RESULTS = [
  { id: 'r1', test: 'HbA1c', value: 7.2, unit: '%', range: '4.0–5.6', flag: 'High', date: '2026-10-03' },
  { id: 'r2', test: 'Fasting glucose', value: 131, unit: 'mg/dL', range: '70–99', flag: 'High', date: '2026-10-03' },
  { id: 'r3', test: 'LDL cholesterol', value: 96, unit: 'mg/dL', range: '< 100', flag: 'Normal', date: '2026-10-03' },
  { id: 'r4', test: 'HDL cholesterol', value: 38, unit: 'mg/dL', range: '> 40', flag: 'Low', date: '2026-10-03' },
  { id: 'r5', test: 'Triglycerides', value: 182, unit: 'mg/dL', range: '< 150', flag: 'High', date: '2026-10-03' },
  { id: 'r6', test: 'Creatinine', value: 0.9, unit: 'mg/dL', range: '0.6–1.1', flag: 'Normal', date: '2026-09-12' },
  { id: 'r7', test: 'TSH', value: 2.1, unit: 'mIU/L', range: '0.4–4.0', flag: 'Normal', date: '2026-09-12' },
  { id: 'r8', test: 'Vitamin D', value: 18, unit: 'ng/mL', range: '30–100', flag: 'Low', date: '2026-08-20' },
];

function resultsGrid(patient) {
  const abnormal = RESULTS.filter((r) => r.flag !== 'Normal').length;
  return {
    id: 'root', type: 'stack', children: [
      { id: 'summary', type: 'alert', props: { tone: abnormal ? 'warning' : 'success', title: `${abnormal} of ${RESULTS.length} results out of range`, text: `Latest panels for ${patient?.name ?? 'this patient'}. Select results to get a plain-language explanation.` } },
      { id: 'grid', type: 'table', props: {
        selectable: 'multi', required: true, pageSize: 6, caption: 'Recent results',
        columns: [
          { key: 'test', label: 'Test' },
          { key: 'value', label: 'Value', format: 'number' },
          { key: 'unit', label: 'Unit' },
          { key: 'flag', label: 'Flag', format: 'badge', tones: { High: 'danger', Low: 'warning', Normal: 'success' } },
          { key: 'date', label: 'Date', format: 'date' },
        ],
        rows: RESULTS,
      } },
      { id: 'updated', type: 'text', props: { text: 'Updated just now', size: 'sm', tone: 'muted' } },
      { id: 'actions', type: 'row', props: { align: 'between' }, children: [
        { id: 'left', type: 'row', props: { gap: 'sm' }, children: [
          { id: 'refresh', type: 'button', props: { label: 'Refresh', actionId: 'refresh' } },
          { id: 'ranges', type: 'button', props: { label: 'Reference ranges', actionId: 'ranges' } },
        ] },
        { id: 'explain', type: 'button', props: { label: 'Explain selected', submit: true } },
      ] },
    ],
  };
}

async function onGridEvent(run, type, payload) {
  if (type === 'ui.action' && payload.actionId === 'refresh') {
    emit(run, 'ui.patch', { uiId: 'results', ops: [{ nodeId: 'updated', set: { text: 'Refreshing…' } }] });
    await sleep(400);
    const at = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return emit(run, 'ui.patch', { uiId: 'results', ops: [{ nodeId: 'updated', set: { text: `Updated at ${at}` } }] });
  }
  if (type === 'ui.action' && payload.actionId === 'ranges') {
    return emit(run, 'ui.render', {
      uiId: 'ranges', surface: 'sheet', schema: 1,
      tree: { id: 'root', type: 'stack', children: [
        { id: 'h', type: 'text', props: { text: 'Reference ranges', size: 'lg', weight: 'bold' } },
        { id: 'list', type: 'list', props: { items: RESULTS.map((r) => ({ title: r.test, subtitle: `${r.range} ${r.unit}`, badge: { text: r.flag, tone: r.flag === 'Normal' ? 'success' : r.flag === 'High' ? 'danger' : 'warning' } })) } },
        { id: 'src', type: 'link', props: { label: 'About lab reference ranges', href: 'https://medlineplus.gov/lab-tests/' } },
      ] },
    });
  }
  if (type === 'ui.submit') {
    const picked = RESULTS.filter((r) => (payload.values?.grid ?? []).includes(r.id));
    emit(run, 'run.progress', { label: `Explaining ${picked.length} result${picked.length === 1 ? '' : 's'}` });
    await sleep(400);
    const lines = picked.map((r) => `- **${r.test} ${r.value} ${r.unit}** (${r.flag.toLowerCase()}, range ${r.range}): ${r.flag === 'Normal' ? 'within the expected range.' : `outside the expected range; review with the patient.`}`);
    emit(run, 'ui.render', {
      uiId: `explain-${run.seq}`, surface: 'inline', schema: 1,
      tree: { id: 'card', type: 'card', props: { title: 'Explanation (demo)' }, children: [{ id: 'md', type: 'markdown', props: { text: lines.join('\n') } }] },
    });
    // Answer the grid itself: clears the selection and unlocks it for another round.
    emit(run, 'ui.patch', { uiId: 'results', ops: [{ nodeId: 'grid', set: { value: [] } }] });
    return emit(run, 'ui.render', { uiId: 'toast', surface: 'toast', schema: 1, tree: { id: 't', type: 'text', props: { text: `Explained ${picked.length} result${picked.length === 1 ? '' : 's'}` } } });
  }
}
