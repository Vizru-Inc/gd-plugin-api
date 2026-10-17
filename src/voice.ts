/**
 * Starts a live voice-agent (Eva) session for the panel.
 *
 * The workflow trigger doesn't send CORS headers, so the browser can't call it
 * directly. The panel calls this route instead; the Worker calls the trigger
 * server-to-server and returns only what the panel needs to open the media
 * WebSocket (WebSockets aren't subject to CORS, so that part stays direct).
 */
import type { Env } from './env';
import { evaPrompt, PANEL_CONFIG } from './panel-config';

export interface VoiceSession {
  session_id: string;
  socket_url: string;
  socket_ns: string;
  token: string;
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));

export async function startVoiceSession(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ status: number; body: VoiceSession | { error: string } }> {
  if (!PANEL_CONFIG.features.voice) return { status: 403, body: { error: 'Voice chat is turned off' } };
  const base = env.WORKFLOW_BASE_URL?.replace(/\/$/, '');
  const workflow = env.VOICE_AGENT_WORKFLOW;
  if (!base || !workflow) {
    return { status: 500, body: { error: 'Server misconfigured: WORKFLOW_BASE_URL / VOICE_AGENT_WORKFLOW are not set' } };
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  };
  if (env.VOICE_AGENT_TOKEN) headers.Authorization = `Bearer ${env.VOICE_AGENT_TOKEN}`;

  let res: Response;
  try {
    res = await fetch(`${base}/workflow.trigger/${encodeURIComponent(workflow)}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        // The base prompt comes from panel-config; the panel only supplies the session context.
        agentPrompt: [evaPrompt(), str(body.sessionContext, 40_000)].filter(Boolean).join('\n\n'),
        admissionId: str(body.admissionId),
        patientName: str(body.patientName),
        isInpatient: str(body.isInpatient ?? 'false'),
      }),
    });
  } catch (err) {
    console.error('voice trigger unreachable', err);
    return { status: 502, body: { error: 'Voice service is unreachable' } };
  }
  if (!res.ok) {
    console.error(`voice trigger ${res.status}`, (await res.text()).slice(0, 500));
    return { status: 502, body: { error: `Voice service returned ${res.status}` } };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { status: 502, body: { error: 'Voice service returned an invalid response' } };
  }
  const s = (Array.isArray(data) ? data[0] : data) as Partial<VoiceSession> | undefined;
  if (!s?.session_id || !s.socket_url || !s.token) {
    return { status: 502, body: { error: 'Voice service did not return a session' } };
  }
  return {
    status: 200,
    body: { session_id: s.session_id, socket_url: s.socket_url, socket_ns: s.socket_ns ?? '/agent-media', token: s.token },
  };
}
