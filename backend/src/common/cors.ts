import type { CorsOptions } from 'cors';

const DEFAULT_DEV_ORIGIN = 'http://localhost:5173';

type CorsEnv = Pick<NodeJS.ProcessEnv, 'CORS_ALLOWED_ORIGINS' | 'FRONTEND_URL' | 'NODE_ENV'>;

export function parseCorsAllowedOrigins(env: CorsEnv = process.env): string[] {
  const configuredOrigins = env.CORS_ALLOWED_ORIGINS ?? env.FRONTEND_URL;

  if (!configuredOrigins) {
    if (env.NODE_ENV === 'production') {
      throw new Error('FRONTEND_URL must be set in production');
    }

    return [DEFAULT_DEV_ORIGIN];
  }

  return configuredOrigins
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
    .filter(origin => env.NODE_ENV !== 'production' || origin !== DEFAULT_DEV_ORIGIN);
}

export function createCorsOptions(env: CorsEnv = process.env): CorsOptions {
  const allowedOrigins = new Set(parseCorsAllowedOrigins(env));

  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
  };
}
