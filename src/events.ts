/**
 * Forwards panel events to the marketplace event receiver workflow:
 *   POST {WORKFLOW_BASE_URL}/workflow.trigger/{EVENTS_WORKFLOW}   form: event, payload (JSON), domain
 *
 * The receiver doesn't send CORS headers, so the panel posts here instead.
 * `domain` comes from the verified session token (the host page's origin),
 * never from the request body.
 */
import type { Env } from './env';

const MAX_PAYLOAD = 512 * 1024;

export function eventsConfigured(env: Env): boolean {
  return !!(env.WORKFLOW_BASE_URL && env.EVENTS_WORKFLOW);
}

export async function forwardEvent(env: Env, event: string, payload: unknown, origin: string): Promise<void> {
  const base = env.WORKFLOW_BASE_URL!.replace(/\/$/, '');
  let domain = origin;
  try {
    domain = new URL(origin).host;
  } catch {
    /* keep the raw origin */
  }
  const body = JSON.stringify(payload ?? null);
  const res = await fetch(`${base}/workflow.trigger/${encodeURIComponent(env.EVENTS_WORKFLOW!)}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      event,
      payload: body.length > MAX_PAYLOAD ? JSON.stringify({ truncated: true, size: body.length }) : body,
      domain,
    }),
  });
  if (!res.ok) console.error(`event ${event} -> receiver ${res.status}`, (await res.text()).slice(0, 300));
}
