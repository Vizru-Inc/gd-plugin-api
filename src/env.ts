export interface Env {
  /** Durable Object namespace: one relay instance per ambient session. */
  AMBIENT_RELAY: DurableObjectNamespace;

  /** Ambient AI server origin, e.g. https://roverv2-fastapi.vizru-ras.com (var). */
  AMBIENT_SERVER_URL?: string;
  /** Ambient subscription key (secret: `wrangler secret put AMBIENT_SUBSCRIPTION_API_KEY`). */
  AMBIENT_SUBSCRIPTION_API_KEY?: string;
  /** Signs session tokens (secret: `wrangler secret put GD_TOKEN_SECRET`). */
  GD_TOKEN_SECRET?: string;
  /**
   * Host-page origins allowed to use the mock test keys, comma-separated.
   * `*` matches any run of characters, e.g. "http://localhost:*,https://*.vizru.com".
   */
  ALLOWED_ORIGINS?: string;
}
