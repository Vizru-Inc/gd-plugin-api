/**
 * MOCK key store. Replace with a real one (per-vendor keys, allowed origins,
 * revocation) when GoodDoc's key management exists. Keep the contract:
 * lookupKey(apiKey) -> { tenantId, features, isAllowed(origin) } | null.
 */
export interface KeyRecord {
  tenantId: string;
  features: string[];
  allowedOrigins: string[];
  isAllowed: (origin: string | null) => boolean;
}

const REVOKED = new Set(['gd_test_revoked1']);
const DEFAULT_ORIGINS = 'http://localhost:*,http://127.0.0.1:*';

/** "https://*.vizru.com" -> /^https:\/\/.*\.vizru\.com$/ */
function toMatcher(pattern: string): RegExp {
  const escaped = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function lookupKey(apiKey: unknown, allowedOriginsSetting: string | undefined): KeyRecord | null {
  if (typeof apiKey !== 'string' || !/^gd_test_[A-Za-z0-9]{8,}$/.test(apiKey) || REVOKED.has(apiKey)) return null;
  const allowedOrigins = (allowedOriginsSetting || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  const matchers = allowedOrigins.map(toMatcher);
  return {
    tenantId: 'tnt_demo_dental',
    features: ['ambient', 'scheduler', 'reports', 'visit-summary', 'launcher'],
    allowedOrigins,
    isAllowed: (origin) => !!origin && matchers.some((m) => m.test(origin)),
  };
}
