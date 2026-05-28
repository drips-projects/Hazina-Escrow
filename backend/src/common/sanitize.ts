import { Request, Response, NextFunction } from 'express';

const HTML_TAG_REGEX = /<\/?[a-z][^>]*>/gi;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;
const WHITESPACE_REGEX = /\s+/g;
const PROTO_POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizeUserText(input: string): string {
  return input
    .replace(HTML_TAG_REGEX, ' ')
    .replace(CONTROL_CHARS_REGEX, ' ')
    .replace(WHITESPACE_REGEX, ' ')
    .trim();
}

function stripProtoPollutingKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripProtoPollutingKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([key]) => !PROTO_POLLUTING_KEYS.has(key))
        .map(([key, val]) => [key, stripProtoPollutingKeys(val)]),
    );
  }
  return obj;
}

export function sanitizeBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = stripProtoPollutingKeys(req.body);
  }
  next();
}
