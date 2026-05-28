import * as Sentry from '@sentry/node';

// SECURITY: Environment variable names that hold cryptographic key material.
// These must never appear in any Sentry event payload shipped to the cloud.
const SENSITIVE_ENV_KEYS: ReadonlySet<string> = new Set([
  'AGENT_WALLET_SECRET',
  'ESCROW_SECRET',
  'API_KEY',
  'ADMIN_API_KEY',
  'SELLER_JWT_SECRET',
  'ANTHROPIC_API_KEY',
  'SENTRY_DSN',
  'DATADOG_API_KEY',
  'DATABASE_URL',
]);

/**
 * Recursively walk an arbitrary value and remove any object key whose name
 * matches a known-sensitive env-var. Returns a sanitised deep copy.
 */
function scrubSensitiveKeys(value: unknown, depth = 0): unknown {
  if (depth > 10 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitiveKeys(item, depth + 1));
  }

  const sanitised: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_ENV_KEYS.has(k)) {
      sanitised[k] = '[REDACTED]';
    } else {
      sanitised[k] = scrubSensitiveKeys(v, depth + 1);
    }
  }
  return sanitised;
}

export function initializeSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || process.env.npm_package_version,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    integrations: [Sentry.httpIntegration()],

    // SECURITY: Strip any key material from every event before it leaves the
    // process. This is a defence-in-depth measure — even if a developer
    // accidentally captures an object that contains process.env or a secret,
    // the value will be redacted here before it is shipped.
    beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
      if (event.extra) {
        event.extra = scrubSensitiveKeys(event.extra) as typeof event.extra;
      }
      if (event.contexts) {
        event.contexts = scrubSensitiveKeys(event.contexts) as typeof event.contexts;
      }
      // Strip request body and env from the server-side context if present.
      if (event.request?.data) {
        event.request.data = '[REDACTED]';
      }
      return event;
    },
  });
}

export { Sentry };
