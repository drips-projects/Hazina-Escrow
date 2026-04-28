import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  WebhookEvent,
  addWebhook,
  getWebhookById,
  getWebhooksForSeller,
  removeWebhook,
  updateWebhook,
} from '../common/storage';
import { validateBody } from '../common/validate';
import { notifySeller } from './webhook.service';
import { requireApiKey } from '../common/auth.middleware';

export const webhooksRouter = Router();

const VALID_EVENTS: WebhookEvent[] = [
  'payment.received',
  'payment.forwarded',
  'dataset.queried',
  'dataset.created',
  'ping',
];

const webhookUrlField = z
  .string()
  .trim()
  .min(1, 'url is required')
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid URL format',
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL must use http or https',
      });
    }
  });

const webhookEventsField = z
  .array(z.string())
  .superRefine((events, ctx) => {
    const invalid = events.filter((e) => !VALID_EVENTS.includes(e as WebhookEvent));
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid events: ${invalid.join(', ')}`,
      });
    }
  })
  .transform((events) => events as WebhookEvent[]);

const createWebhookSchema = z.object({
  sellerWallet: z
    .string({ required_error: 'sellerWallet is required' })
    .trim()
    .min(1, 'sellerWallet is required')
    .max(200),
  url: webhookUrlField,
  secret: z.string({ required_error: 'secret is required' }).min(1, 'secret is required').max(500),
  events: webhookEventsField.optional(),
});

const updateWebhookSchema = z
  .object({
    url: webhookUrlField.optional(),
    secret: z.string().min(1, 'secret must be a non-empty string').max(500).optional(),
    events: webhookEventsField.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.url !== undefined ||
      data.secret !== undefined ||
      data.events !== undefined ||
      data.active !== undefined,
    { message: 'At least one of url, secret, events, or active must be provided' },
  );

// POST /api/webhooks — register a new webhook
webhooksRouter.post('/', requireApiKey, validateBody(createWebhookSchema), async (req: Request, res: Response) => {
  const { sellerWallet, url, secret, events } = req.body as z.infer<typeof createWebhookSchema>;

  const webhook = {
    id: `wh-${uuidv4()}`,
    sellerWallet,
    url,
    secret,
    events: events ?? [],
    active: true,
    createdAt: new Date().toISOString(),
  };

  await addWebhook(webhook);

  return res.status(201).json({
    success: true,
    webhook: {
      id: webhook.id,
      sellerWallet: webhook.sellerWallet,
      url: webhook.url,
      events: webhook.events,
      active: webhook.active,
      createdAt: webhook.createdAt,
    },
  });
});

// GET /api/webhooks/:sellerWallet — list webhooks for a seller
webhooksRouter.get('/:sellerWallet', async (req: Request, res: Response) => {
  const webhooks = await getWebhooksForSeller(req.params.sellerWallet);
  return res.json({
    success: true,
    webhooks: webhooks.map(({ secret: _secret, ...rest }) => rest),
  });
});

// DELETE /api/webhooks/:id — remove a webhook
webhooksRouter.delete('/:id', requireApiKey, async (req: Request, res: Response) => {
  const webhook = await getWebhookById(req.params.id);
  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  await removeWebhook(req.params.id);
  return res.json({ success: true, message: 'Webhook deleted' });
});

// POST /api/webhooks/:id/test — send a test ping event
webhooksRouter.post('/:id/test', requireApiKey, async (req: Request, res: Response) => {
  const webhook = await getWebhookById(req.params.id);
  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  if (!webhook.active) {
    return res.status(400).json({ error: 'Webhook is inactive' });
  }

  try {
    await notifySeller(webhook.sellerWallet, 'ping', {
      message: 'Test ping from Hazina Escrow',
      webhookId: webhook.id,
    });
    return res.json({ success: true, message: 'Test ping dispatched' });
  } catch {
    return res.status(500).json({ error: 'Failed to dispatch test ping' });
  }
});

// PATCH /api/webhooks/:id — update webhook (url, secret, events, active)
webhooksRouter.patch('/:id', requireApiKey, validateBody(updateWebhookSchema), async (req: Request, res: Response) => {
  const webhook = await getWebhookById(req.params.id);
  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  const updates = req.body as z.infer<typeof updateWebhookSchema>;
  const updated = await updateWebhook(req.params.id, updates);
  if (!updated) {
    return res.status(500).json({ error: 'Failed to update webhook' });
  }

  const { secret: _secret, ...rest } = updated;
  return res.json({ success: true, webhook: rest });
});

