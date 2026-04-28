import { initializeDatadog } from './common/datadog';
import { initializeSentry, Sentry } from './common/sentry';
import dotenv from 'dotenv';

dotenv.config();
initializeDatadog();
initializeSentry();

import express, { Request } from 'express';
import cors from 'cors';
import path from 'path';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

import { datasetsRouter } from './datasets/datasets.router';
import { paymentsRouter } from './payments/payments.router';
import { agentRouter } from './agent/agent.router';
import { webhooksRouter } from './webhooks/webhook.router';
import { readStore } from './common/storage';
import { BackupScheduler } from './common/backup.scheduler';
import { backupRouter, setBackupScheduler } from './common/backup.router';
import { createCompressionMiddleware } from './common/compression';
import { HORIZON_URL } from './lib/stellar.config';

const app = express();
const PORT = process.env.PORT || 3001;

// Compress all compressible API responses (brotli preferred, gzip fallback)
app.use(createCompressionMiddleware());
// Ensure client IP is derived correctly when running behind a reverse proxy.
app.set('trust proxy', 1);

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
app.use(express.json({ limit: '2mb' }));
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

// Demo limiters first (more specific), then strict, then global on /api
app.use('/api/verify/:id/demo', demoLimiter);
app.use('/api/agent/research/demo', demoLimiter);
app.use('/api/verify', strictLimiter);
app.use('/api/agent/research', strictLimiter);
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

const swaggerDocs = swaggerJsdoc(swaggerOptions);
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

// Global error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: () => void) => {
  const message = err.message || 'Internal server error';
  console.error('[Global Error Handler]', err);
  Sentry.captureException(err);
  res.status(500).json({ error: message });
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

// Routes
app.use('/api/datasets', datasetsRouter);
app.use('/api', paymentsRouter);
app.use('/api/agent', agentRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api', backupRouter);

app.listen(PORT, () => {
  console.log(`\n  ██╗  ██╗ █████╗ ███████╗██╗███╗   ██╗ █████╗`);
  console.log(`  ██║  ██║██╔══██╗╚══███╔╝██║████╗  ██║██╔══██╗`);
  console.log(`  ███████║███████║  ███╔╝ ██║██╔██╗ ██║███████║`);
  console.log(`  ██╔══██║██╔══██║ ███╔╝  ██║██║╚██╗██║██╔══██║`);
  console.log(`  ██║  ██║██║  ██║███████╗██║██║ ╚████║██║  ██║`);
  console.log(`  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝`);
  console.log(`\n  Data Escrow API running on http://localhost:${PORT}\n`);
});

export default app;
