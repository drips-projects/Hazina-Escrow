import { describe, it, expect } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import zlib from 'zlib';
import { createCompressionMiddleware } from '../compression';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Supertest's default HTTP client automatically sends `Accept-Encoding: gzip, deflate`.
 * Use `.buffer(true).parse(rawParser)` to receive the raw bytes before any client-side
 * decompression, so we can assert on the actual compressed output.
 */
function rawParser(
  res: import('http').IncomingMessage,
  cb: (err: Error | null, body: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
  res.on('error', cb);
}

/** Build a minimal Express app with the compression middleware + test routes. */
function buildApp(opts?: Parameters<typeof createCompressionMiddleware>[0]) {
  const app = express();
  app.use(createCompressionMiddleware(opts));

  app.get('/json', (_req: Request, res: Response) => {
    res.json({ data: 'x'.repeat(2048) }); // >1 KB
  });
  app.get('/tiny', (_req: Request, res: Response) => {
    res.json({ ok: true }); // <1 KB
  });
  app.get('/text', (_req: Request, res: Response) => {
    res.type('text/plain').send('y'.repeat(2048));
  });
  app.get('/image', (_req: Request, res: Response) => {
    res.type('image/png').send(Buffer.alloc(2048, 0x42));
  });
  return app;
}

// ── Brotli ────────────────────────────────────────────────────────────────────

describe('compression — brotli (br)', () => {
  it('compresses a large JSON response when client accepts br', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/json')
      .set('Accept-Encoding', 'br')
      .buffer(true)
      .parse(rawParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    const decompressed = zlib.brotliDecompressSync(res.body as unknown as Buffer).toString();
    expect(JSON.parse(decompressed)).toMatchObject({ data: expect.any(String) });
  });

  it('sets Vary: Accept-Encoding header', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/json')
      .set('Accept-Encoding', 'br')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['vary']).toBe('Accept-Encoding');
  });

  it('removes Content-Length after compression', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/json')
      .set('Accept-Encoding', 'br')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['content-length']).toBeUndefined();
  });
});

// ── Gzip ──────────────────────────────────────────────────────────────────────

describe('compression — gzip', () => {
  it('compresses a large JSON response when client accepts gzip', async () => {
    const app = buildApp();
    // Superagent auto-decompresses gzip, so check the header and that
    // the body round-trips correctly (no manual gunzip needed).
    const res = await request(app).get('/json').set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    // Body should have been transparently decompressed by superagent
    expect(res.body).toMatchObject({ data: expect.any(String) });
  });
});

// ── Encoding negotiation ──────────────────────────────────────────────────────

describe('compression — encoding negotiation', () => {
  it('prefers br over gzip when both have equal q-values', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/json')
      .set('Accept-Encoding', 'gzip, br')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['content-encoding']).toBe('br');
  });

  it('honours explicit q-values (gzip;q=0.9 wins over br;q=0.5)', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/json')
      .set('Accept-Encoding', 'br;q=0.5, gzip;q=0.9')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('does not compress when only identity is accepted', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/json')
      .set('Accept-Encoding', 'identity')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

// ── Threshold ─────────────────────────────────────────────────────────────────

describe('compression — threshold', () => {
  it('skips compression for responses below the 1 KB default threshold', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/tiny')
      .set('Accept-Encoding', 'br, gzip')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('honours a custom threshold=0 (compresses even tiny payloads)', async () => {
    const app = buildApp({ threshold: 0 });
    const res = await request(app)
      .get('/tiny')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['content-encoding']).toBe('gzip');
  });
});

// ── Content-Type filtering ────────────────────────────────────────────────────

describe('compression — content-type filtering', () => {
  it('compresses text/plain responses', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/text')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('does NOT compress binary image/png responses', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/image')
      .set('Accept-Encoding', 'br, gzip')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

// ── Vary header ───────────────────────────────────────────────────────────────

describe('compression — Vary header', () => {
  it('always sets Vary: Accept-Encoding even when not compressing', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/tiny')
      .set('Accept-Encoding', 'identity')
      .buffer(true)
      .parse(rawParser);
    expect(res.headers['vary']).toBe('Accept-Encoding');
  });
});
