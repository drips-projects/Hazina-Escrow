import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  getAllDatasets,
  getDataset,
  addDataset,
  getTransactions,
  getTransactionsCount,
  Dataset,
} from '../common/storage';
import { validateBody } from '../common/validate';
import { sanitizeUserText } from '../common/sanitize';
import { notifySeller } from '../webhooks/webhook.service';
import { requireApiKey } from '../common/auth.middleware';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;
const MAX_DATA_BYTES = 500 * 1024;
const makeSanitizedTextField = (fieldName: string, maxLength: number) =>
  z.string().transform(sanitizeUserText).superRefine((value, ctx) => {
    if (value.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${fieldName} is required`,
      });
      return;
    }
    if (value.length > maxLength) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${fieldName} must be at most ${maxLength} characters`,
      });
    }
  });

const dataField = z
  .union([z.string(), z.record(z.unknown())])
  .transform((val, ctx): Record<string, unknown> => {
    let parsed: unknown;
    if (typeof val === 'string') {
      try {
        parsed = JSON.parse(val);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'data must be valid JSON',
        });
        return z.NEVER;
      }
    } else {
      parsed = val;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'data must be a JSON object',
      });
      return z.NEVER;
    }
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_DATA_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'data exceeds 500 KB limit',
      });
      return z.NEVER;
    }
    return parsed as Record<string, unknown>;
  });

const createDatasetSchema = z.object({
  name: makeSanitizedTextField('name', 200),
  description: makeSanitizedTextField('description', 2000),
  type: makeSanitizedTextField('type', 100),
  pricePerQuery: z.coerce.number().finite().positive(),
  sellerWallet: z
    .string()
    .trim()
    .regex(STELLAR_ADDRESS_REGEX, 'must be a valid Stellar G-address'),
  data: dataField,
});

/**
 * @openapi
 * components:
 *   schemas:
 *     Dataset:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         type:
 *           type: string
 *         pricePerQuery:
 *           type: number
 *         sellerWallet:
 *           type: string
 *         queriesServed:
 *           type: integer
 *         totalEarned:
 *           type: number
 *         createdAt:
 *           type: string
 *           format: date-time
 */

export const datasetsRouter = Router();

/**
 * @openapi
 * /api/datasets:
 *   get:
 *     summary: List datasets with pagination and filters
 *     description: Retrieve datasets excluding their raw data content, with support for pagination, searching, filtering by type, and sorting.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 12
 *           maximum: 50
 *         description: Number of items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for name or description
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter by dataset type
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [popular, price-asc, price-desc, newest]
 *           default: popular
 *         description: Sort order
 *     responses:
 *       200:
 *         description: A paginated list of datasets
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Dataset'
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *       400:
 *         description: Invalid pagination parameters
 */


// GET /api/datasets — list datasets with pagination, filtering, and sorting
datasetsRouter.get('/', (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 12;
  const search = (req.query.search as string || '').toLowerCase();
  const type = req.query.type as string;
  const sort = req.query.sort as string || 'popular';

  if (isNaN(page) || page < 1 || isNaN(limit) || limit < 1) {
    return res.status(400).json({ error: 'Invalid page or limit' });
  }

  if (limit > 50) {
    return res.status(400).json({ error: 'Limit exceeds maximum of 50' });
  }

  let datasets = getAllDatasets().map(({ data: _data, ...rest }) => rest);

  // Filter
  if (search) {
    datasets = datasets.filter(
      (d) =>
        d.name.toLowerCase().includes(search) ||
        d.description.toLowerCase().includes(search)
    );
  }
  if (type) {
    datasets = datasets.filter((d) => d.type === type);
  }

  // Sort
  datasets.sort((a, b) => {
    if (sort === 'popular') return b.queriesServed - a.queriesServed;
    if (sort === 'price-asc') return a.pricePerQuery - b.pricePerQuery;
    if (sort === 'price-desc') return b.pricePerQuery - a.pricePerQuery;
    if (sort === 'newest')
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return 0;
  });

  const total = datasets.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const data = datasets.slice(start, start + limit);

  res.json({
    data,
    total,
    page,
    totalPages,
  });
});

/**
 * @openapi
 * /api/datasets/stats:
 *   get:
 *     summary: Get platform statistics
 *     description: Retrieve global statistics including total datasets, queries, and earnings
 *     responses:
 *       200:
 *         description: Platform statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stats:
 *                   type: object
 *                   properties:
 *                     totalDatasets:
 *                       type: integer
 *                     totalQueries:
 *                       type: integer
 *                     totalUsdcEarned:
 *                       type: number
 *                     totalTransactions:
 *                       type: integer
 */
datasetsRouter.get('/stats', (_req: Request, res: Response) => {
  const datasets = getAllDatasets();
  const transactions = getTransactions();
  res.json({
    success: true,
    stats: {
      totalDatasets: datasets.length,
      totalQueries: datasets.reduce((s, d) => s + d.queriesServed, 0),
      totalUsdcEarned: datasets.reduce((s, d) => s + d.totalEarned, 0),
      totalTransactions: transactions.length,
    },
  });
});

/**
 * @openapi
 * /api/datasets/transactions:
 *   get:
 *     summary: Get all transactions across all datasets
 *     description: Retrieve all transactions in a single call (no dataset filter)
 *     responses:
 *       200:
 *         description: List of all transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 */
datasetsRouter.get('/transactions', (_req: Request, res: Response) => {
  const transactions = getTransactions();
  return res.json({ success: true, transactions });
});

/**
 * @openapi
 * /api/datasets/{id}:
 *   get:
 *     summary: Get dataset by ID
 *     description: Retrieve single dataset metadata by ID (excludes raw data)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dataset metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 dataset:
 *                   $ref: '#/components/schemas/Dataset'
 *       404:
 *         description: Dataset not found
 */
datasetsRouter.get('/:id', (req: Request, res: Response) => {
  const dataset = getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
  const { data: _data, ...meta } = dataset;
  return res.json({ success: true, dataset: meta });
});

/**
 * @openapi
 * /api/datasets/{id}/transactions:
 *   get:
 *     summary: Get dataset transactions
 *     description: Retrieve transaction history for a specific dataset
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 */
datasetsRouter.get('/:id/transactions', (req: Request, res: Response) => {
  const dataset = getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
  
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  const transactions = getTransactions(req.params.id, limit, offset);
  const total = getTransactionsCount(req.params.id);
  
  return res.json({ success: true, transactions, total, limit, offset });
});

/**
 * @openapi
 * /api/datasets:
 *   post:
 *     summary: Create a new dataset
 *     description: List a new dataset on the platform
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - description
 *               - type
 *               - pricePerQuery
 *               - sellerWallet
 *               - data
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               type:
 *                 type: string
 *               pricePerQuery:
 *                 type: number
 *               sellerWallet:
 *                 type: string
 *               data:
 *                 type: object
 *     responses:
 *       201:
 *         description: Dataset created successfully
 *       400:
 *         description: Missing required fields or invalid price
 */
datasetsRouter.post('/', requireApiKey, validateBody(createDatasetSchema), (req: Request, res: Response) => {
  const { name, description, type, pricePerQuery, sellerWallet, data } =
    req.body as z.infer<typeof createDatasetSchema>;

  const dataset: Dataset = {
    id: `ds-${uuidv4()}`,
    name,
    description,
    type,
    pricePerQuery,
    sellerWallet,
    data,
    queriesServed: 0,
    totalEarned: 0,
    createdAt: new Date().toISOString(),
  };

  addDataset(dataset);

  // Notify seller via webhook
  notifySeller(dataset.sellerWallet, 'dataset.created', {
    datasetId: dataset.id,
    datasetName: dataset.name,
    type: dataset.type,
    pricePerQuery: dataset.pricePerQuery,
  }).catch(() => {});

  const { data: _d, ...meta } = dataset;
  return res.status(201).json({ success: true, dataset: meta });
});
