import { initializeDatadog } from './common/datadog';
import { initializeSentry, Sentry } from './common/sentry';
import dotenv from 'dotenv';

dotenv.config();
initializeDatadog();
initializeSentry();

import 'express-async-errors';
import express, { Request, Response, NextFunction } from 'express';
import pino from 'pino';
import { randomUUID } from 'crypto';
import cors from 'cors';
import path from 'path';
import http from 'http';
import rateLimit from 'express-rate-limit';
import _swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

import { datasetsRouter } from './datasets/datasets.router';
import {
  paymentsRouter,
  startDeliveryRetryWorker,
  stopDeliveryRetryWorker,
} from './payments/payments.router';
import { agentRouter } from './agent/agent.router';
import { webhooksRouter } from './webhooks/webhook.router';
import { readStore } from './common/storage';
import { BackupScheduler } from './common/backup.scheduler';
import { backupRouter, setBackupScheduler } from './common/backup.router';
import { createCompressionMiddleware } from './common/compression';
import { initializeWebSocketServer } from './websocket/ws-server';
import { HORIZON_URL } from './lib/stellar.config';
import { createCorsOptions } from './common/cors';
import { sanitizeBody } from './common/sanitize';

const app = express();
const PORT = process.env.PORT || 3001;

const isProduction = process.env.NODE_ENV === 'production';
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
    ],
    censor: '[REDACTED]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }),
});

const sanitizeHeaders = (headers: Record<string, unknown>) => ({
  ...headers,
  ...(headers.authorization ? { authorization: '[REDACTED]' } : {}),
  ...(headers.cookie ? { cookie: '[REDACTED]' } : {}),
});

app.use(createCompressionMiddleware());
// Ensure client IP is derived correctly when running behind a reverse proxy.
app.set('trust proxy', 1);

// Request correlation ID middleware — runs before all routes so every log line
// and error response can include the same unique ID for a given request.
// Honours a forwarded x-request-id from the client (e.g. the frontend or an
// upstream proxy); falls back to a fresh UUID when none is provided.
app.use((req: Request, res: Response, next: NextFunction) => {
  req.id = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  const requestLogger = logger.child({ requestId: req.id });

  const onFinish = () => {
    const durationMs = Date.now() - startTime;

    const logPayload = {
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs,
      headers: sanitizeHeaders(req.headers as Record<string, unknown>),
    };

    if (res.statusCode >= 500) {
      requestLogger.error(logPayload, 'HTTP request completed');
    } else if (res.statusCode >= 400) {
      requestLogger.warn(logPayload, 'HTTP request completed');
    } else {
      requestLogger.info(logPayload, 'HTTP request completed');
    }
  };

  res.on('finish', onFinish);
  res.on('close', () => {
    if (!res.writableEnded) {
      const durationMs = Date.now() - startTime;
      requestLogger.warn(
        {
          method: req.method,
          url: req.originalUrl || req.url,
          statusCode: res.statusCode,
          durationMs,
          headers: sanitizeHeaders(req.headers as Record<string, unknown>),
        },
        'HTTP request aborted',
      );
    }
  });

  next();
});

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: '2mb' }));
app.use(sanitizeBody);
Sentry.setupExpressErrorHandler(app);

// Rate limiting — global + per-route limits for sensitive endpoints
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const isDemoRoute = (req: Request): boolean => req.originalUrl.split('?')[0].endsWith('/demo');

const globalLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

const strictLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isDemoRoute,
  message: { error: 'Too many requests' },
});

const demoLimiter = rateLimit({
  windowMs: ONE_HOUR_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Demo limiters first (more specific), then strict, then global on /api/v1
app.use('/api/v1/verify/:id/demo', demoLimiter);
app.use('/api/v1/agent/research/demo', demoLimiter);
app.use('/api/v1/verify', strictLimiter);
app.use('/api/v1/agent/research', strictLimiter);
app.use(globalLimiter);

// Initialize backup scheduler
const backupEnabled = process.env.BACKUP_ENABLED !== 'false';
if (backupEnabled) {
  const backupScheduler = new BackupScheduler({
    enabled: true,
    backupDir: process.env.BACKUP_DIR || path.join(__dirname, '../../backups'),
    maxBackups: parseInt(process.env.BACKUP_MAX_BACKUPS || '30', 10),
    cronSchedule: process.env.BACKUP_CRON_SCHEDULE || '0 0 * * *', // Daily at midnight by default
  });

  backupScheduler.start();
  setBackupScheduler(backupScheduler);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[Backup] Stopping backup scheduler...');
    backupScheduler.stop();
  });

  process.on('SIGINT', () => {
    console.log('[Backup] Stopping backup scheduler...');
    backupScheduler.stop();
    process.exit(0);
  });
}

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Hazina Escrow API',
      version: '1.0.0',
      description: 'API documentation for Hazina Data Escrow platform',
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Local development server',
      },
    ],
  },
  apis: ['./src/**/*.ts'], // Path to the API docs
};

const _swaggerDocs = swaggerJsdoc(swaggerOptions);
// Health check with service monitoring
const HEALTH_TIMEOUT_MS = 3000;

type CheckResult = 'ok' | 'error';

async function withHealthTimeout(fn: () => Promise<CheckResult>): Promise<CheckResult> {
  return Promise.race<CheckResult>([
    fn().catch(() => 'error'),
    new Promise<CheckResult>(resolve => setTimeout(() => resolve('error'), HEALTH_TIMEOUT_MS)),
  ]);
}

async function checkStorage(): Promise<CheckResult> {
  try {
    await readStore();
    return 'ok';
  } catch {
    return 'error';
  }
}

async function checkAnthropic(): Promise<CheckResult> {
  return process.env.ANTHROPIC_API_KEY ? 'ok' : 'error';
}

async function checkStellar(): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(HORIZON_URL, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

app.get('/health', async (_req, res) => {
  const [storage, anthropic, stellar] = await Promise.all([
    withHealthTimeout(checkStorage),
    withHealthTimeout(checkAnthropic),
    withHealthTimeout(checkStellar),
  ]);

  const checks = { storage, anthropic, stellar };
  const allOk = storage === 'ok' && anthropic === 'ok' && stellar === 'ok';

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Unhandled Rejection]', reason);
  Sentry.captureException(reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err: Error) => {
  console.error('[Uncaught Exception]', err);
  Sentry.captureException(err);
});

// Routes under versioned API namespace.
const v1Router = express.Router();

v1Router.use('/datasets', datasetsRouter);
v1Router.use('/agent', agentRouter);
v1Router.use('/webhooks', webhooksRouter);
v1Router.use('/payments', paymentsRouter);
v1Router.use('/backups', backupRouter);

app.use('/api/v1', v1Router);

// Legacy /api routes redirect to /api/v1 for a transition period.
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (req.originalUrl.startsWith('/api/v1')) {
    return next();
  }

  const targetUrl = `/api/v1${req.originalUrl.slice('/api'.length)}`;
  res.setHeader('Warning', '299 - "Deprecated API version. Use /api/v1/."');
  res.setHeader('Deprecation', 'true');
  res.redirect(308, targetUrl);
});

// Global error handling middleware — Issue #283 (standard error shape)
app.use(
  (
    err: Error & { status?: number; code?: string },
    req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const status = err.status ?? 500;
    const message = err.message || 'Internal server error';
    console.error(`[Global Error Handler] [requestId=${req.id}]`, err);
    Sentry.captureException(err);
    res
      .status(status)
      .json({ error: message, code: err.code || 'INTERNAL_ERROR', requestId: req.id });
  },
);

startDeliveryRetryWorker();

// Create HTTP server and attach Express app
const server = http.createServer(app);

// Initialize WebSocket server
const wsApiKey = process.env.WEBSOCKET_API_KEY || '';
const wsServer = initializeWebSocketServer(server, wsApiKey);

// Add endpoint for WebSocket server stats
app.get('/api/v1/ws/stats', (_req: Request, res: Response) => {
  res.json(wsServer.getStats());
});

server.listen(PORT, () => {
  console.log(`\n  ██╗  ██╗ █████╗ ███████╗██╗███╗   ██╗ █████╗`);
  console.log(`  ██║  ██║██╔══██╗╚══███╔╝██║████╗  ██║██╔══██╗`);
  console.log(`  ███████║███████║  ███╔╝ ██║██╔██╗ ██║███████║`);
  console.log(`  ██╔══██║██╔══██║ ███╔╝  ██║██║╚██╗██║██╔══██║`);
  console.log(`  ██║  ██║██║  ██║███████╗██║██║ ╚████║██║  ██║`);
  console.log(`  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝`);
  console.log(`\n  Data Escrow API running on http://localhost:${PORT}`);
  console.log(`  WebSocket server running on ws://localhost:${PORT}/ws\n`);
});

// Graceful shutdown for WebSocket server
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down gracefully...');
  stopDeliveryRetryWorker();
  wsServer.shutdown();
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] Shutting down gracefully...');
  stopDeliveryRetryWorker();
  wsServer.shutdown();
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
});

export default app;
