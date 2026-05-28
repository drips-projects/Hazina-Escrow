import { describe, it, expect, vi } from 'vitest';
import { sanitizeUserText, sanitizeBody } from '../sanitize';
import type { Request, Response, NextFunction } from 'express';

describe('sanitizeUserText', () => {
  it('removes HTML tags and trims whitespace', () => {
    const result = sanitizeUserText('  <script>alert(1)</script> Hello  ');
    expect(result).toBe('alert(1) Hello');
  });

  it('removes control characters', () => {
    const result = sanitizeUserText('line-1\u0000\u0008line-2');
    expect(result).toBe('line-1 line-2');
  });

  it('collapses repeated whitespace', () => {
    const result = sanitizeUserText('A   B\t\tC\n\nD');
    expect(result).toBe('A B C D');
  });

  it('preserves non-HTML angle bracket text', () => {
    const result = sanitizeUserText('show rows where value < 10 and > 2');
    expect(result).toBe('show rows where value < 10 and > 2');
  });

  it('strips XSS payload from string field', () => {
    const result = sanitizeUserText('<img src=x onerror=alert(1)>safe text');
    expect(result).not.toContain('<img');
    expect(result).toContain('safe text');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeUserText('  hello  ')).toBe('hello');
  });
});

describe('sanitizeBody middleware', () => {
  function makeReq(body: unknown): Request {
    return { body } as Request;
  }

  it('strips __proto__ key from request body', () => {
    const req = makeReq(JSON.parse('{"__proto__":{"admin":true},"name":"test"}'));
    sanitizeBody(req, {} as Response, vi.fn() as unknown as NextFunction);
    expect(req.body).not.toHaveProperty('__proto__');
    expect(req.body.name).toBe('test');
  });

  it('strips constructor key from request body', () => {
    const req = makeReq({ constructor: { prototype: { x: 1 } }, value: 42 });
    sanitizeBody(req, {} as Response, vi.fn() as unknown as NextFunction);
    expect(req.body).not.toHaveProperty('constructor');
    expect(req.body.value).toBe(42);
  });

  it('strips prototype pollution keys from nested objects', () => {
    const req = makeReq({ nested: { __proto__: { evil: true }, safe: 'yes' } });
    sanitizeBody(req, {} as Response, vi.fn() as unknown as NextFunction);
    expect(req.body.nested).not.toHaveProperty('__proto__');
    expect(req.body.nested.safe).toBe('yes');
  });

  it('calls next()', () => {
    const next = vi.fn();
    const req = makeReq({ a: 1 });
    sanitizeBody(req, {} as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });
});
