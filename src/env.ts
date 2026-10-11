export interface Env {
  /** Durable Object namespace: one relay instance per ambient session. */
  AMBIENT_RELAY: DurableObjectNamespace;

  /** Ambient AI server origin, e.g. https://roverv2-fastapi.vizru-ras.com (var). */
  AMBIENT_SERVER_URL?: string;
  /** Ambient subscription key (secret: `wrangler secret put AMBIENT_SUBSCRIPTION_API_KEY`). */
  AMBIENT_SUBSCRIPTION_API_KEY?: string;
  /** Origin of the workflow server (voice agent, event receiver), e.g. https://innov-dev.beta.injomo.com (var). */
  WORKFLOW_BASE_URL?: string;
  /** Live voice agent (Eva) workflow id, called at {WORKFLOW_BASE_URL}/workflow.trigger/{id} (var). */
  VOICE_AGENT_WORKFLOW?: string;
  /** Workflow id that receives every panel event (event, payload, domain) (var). */
  EVENTS_WORKFLOW?: string;
  /** Optional bearer token for the workflow trigger (secret: `wrangler secret put VOICE_AGENT_TOKEN`). */
  VOICE_AGENT_TOKEN?: string;
  /** Signs session tokens (secret: `wrangler secret put GD_TOKEN_SECRET`). */
  GD_TOKEN_SECRET?: string;
  /**
   * Host-page origins allowed to use the mock test keys, comma-separated.
   * `*` matches any run of characters, e.g. "http://localhost:*,https://*.vizru.com".
   */
  ALLOWED_ORIGINS?: string;
}
