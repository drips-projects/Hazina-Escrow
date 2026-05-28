import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';
import {
  getAllDatasets,
  getDataset,
  addDataset,
  getTransactions,
  getTransactionsCount,
} from './datasets.repository';
import type { Dataset } from '../common/storage';
import { validateBody } from '../common/validate';
import { sanitizeUserText } from '../common/sanitize';
import { notifySeller } from '../webhooks/webhook.service';
import { requireApiKey } from '../common/auth.middleware';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;
const MAX_DATA_KB = 500;
const MAX_DATA_BYTES = MAX_DATA_KB * 1024;
const makeSanitizedTextField = (fieldName: string, maxLength: number) =>
  z
    .string()
    .transform(sanitizeUserText)
    .superRefine((value, ctx) => {
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
        message: `data exceeds ${MAX_DATA_KB} KB limit`,
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
  sellerWallet: z.string().trim().refine(StrKey.isValidEd25519PublicKey, { message: 'Invalid Stellar address' }),
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

function withoutRawData(dataset: Dataset) {
  const { data: _data, ...meta } = dataset;
  return meta;
}

async function getSellerDashboardData(sellerWallet: string) {
  const allDatasets = await getAllDatasets();
  const sellerDatasets = allDatasets.filter(dataset => dataset.sellerWallet === sellerWallet);
  const sellerDatasetIds = new Set(sellerDatasets.map(dataset => dataset.id));
  const transactions = (await getTransactions()).filter(transaction =>
    sellerDatasetIds.has(transaction.datasetId),
  );

  return {
    datasets: sellerDatasets.map(withoutRawData),
    transactions,
    stats: {
      totalDatasets: sellerDatasets.length,
      totalQueries: sellerDatasets.reduce((sum, dataset) => sum + dataset.queriesServed, 0),
      totalUsdcEarned: sellerDatasets.reduce((sum, dataset) => sum + dataset.totalEarned, 0),
      totalTransactions: transactions.length,
    },
  };
}

/**
 * @openapi
 * /api/datasets:
 *   get:
 *     summary: List datasets with pagination and filters
 *     description: Retrieve datasets excluding their raw data content, with support for pagination, searching, multi-select type filters, range filters, and sorting.
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
 *           default: 20
 *           maximum: 100
 *         description: Number of items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for name or description
 *       - in: query
 *         name: type
 *         schema:
 *           oneOf:
 *             - type: string
 *             - type: array
 *               items:
 *                 type: string
 *         description: Filter by one or more dataset types. Repeat the parameter or pass comma-separated values.
 *       - in: query
 *         name: minPrice
 *         schema:
 *           type: number
 *         description: Minimum price per query
 *       - in: query
 *         name: maxPrice
 *         schema:
 *           type: number
 *         description: Maximum price per query
 *       - in: query
 *         name: minQueries
 *         schema:
 *           type: integer
 *         description: Minimum queries served
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
 *                 pageSize:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *       400:
 *         description: Invalid pagination parameters
 */

// GET /api/datasets — list datasets with pagination, filtering, and sorting
datasetsRouter.get('/', async (req: Request, res: Response) => {
  const parsedPage = Number.parseInt(req.query.page as string, 10);
  const parsedLimit = Number.parseInt(req.query.limit as string, 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20;
  const search = ((req.query.search as string) || '').toLowerCase();
  const types = [req.query.type]
    .flat()
    .filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);
  const minPrice = req.query.minPrice === undefined ? undefined : Number(req.query.minPrice);
  const maxPrice = req.query.maxPrice === undefined ? undefined : Number(req.query.maxPrice);
  const minQueries = req.query.minQueries === undefined ? undefined : Number(req.query.minQueries);
  const sort = (req.query.sort as string) || 'popular';

  if (
    (req.query.page !== undefined && (!Number.isFinite(parsedPage) || parsedPage < 1)) ||
    (req.query.limit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1))
  ) {
    return res.status(400).json({ error: 'Invalid page or limit' });
  }

  if (
    (minPrice !== undefined && (!Number.isFinite(minPrice) || minPrice < 0)) ||
    (maxPrice !== undefined && (!Number.isFinite(maxPrice) || maxPrice < 0)) ||
    (minQueries !== undefined && (!Number.isFinite(minQueries) || minQueries < 0))
  ) {
    return res.status(400).json({ error: 'Invalid filter range' });
  }

  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    return res.status(400).json({ error: 'Minimum price cannot exceed maximum price' });
  }

  let datasets = (await getAllDatasets()).map(withoutRawData);

  // Filter
  if (search) {
    datasets = datasets.filter(
      d => d.name.toLowerCase().includes(search) || d.description.toLowerCase().includes(search),
    );
  }
  if (types.length > 0) {
    const selectedTypes = new Set(types);
    datasets = datasets.filter(d => selectedTypes.has(d.type));
  }
  if (minPrice !== undefined) {
    datasets = datasets.filter(d => d.pricePerQuery >= minPrice);
  }
  if (maxPrice !== undefined) {
    datasets = datasets.filter(d => d.pricePerQuery <= maxPrice);
  }
  if (minQueries !== undefined) {
    datasets = datasets.filter(d => d.queriesServed >= minQueries);
  }

  // Sort
  datasets.sort((a, b) => {
    if (sort === 'popular') return b.queriesServed - a.queriesServed;
    if (sort === 'price-asc') return a.pricePerQuery - b.pricePerQuery;
    if (sort === 'price-desc') return b.pricePerQuery - a.pricePerQuery;
    if (sort === 'newest') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
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
    pageSize: limit,
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
datasetsRouter.get('/stats', async (_req: Request, res: Response) => {
  const datasets = await getAllDatasets();
  const transactions = await getTransactions();
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
 * /api/datasets/seller/dashboard:
 *   get:
 *     summary: Get authenticated seller dashboard data
 *     description: Retrieve datasets, transactions, and summary stats scoped to the sellerWallet JWT claim.
 *     responses:
 *       200:
 *         description: Seller dashboard payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 sellerWallet:
 *                   type: string
 *                 datasets:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Dataset'
 *                 stats:
 *                   type: object
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 */
datasetsRouter.get('/seller/dashboard', requireSellerJwt, async (req: Request, res: Response) => {
  const sellerWallet = req.sellerAuth?.sellerWallet;
  if (!sellerWallet) return res.status(401).json({ error: 'Invalid seller token' });

  const dashboard = await getSellerDashboardData(sellerWallet);
  return res.json({ success: true, sellerWallet, ...dashboard });
});

/**
 * @openapi
 * /api/datasets/transactions:
 *   get:
 *     summary: Get authenticated seller transactions
 *     description: Retrieve transactions scoped to the sellerWallet JWT claim.
 *     responses:
 *       200:
 *         description: List of seller transactions
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
datasetsRouter.get('/transactions', requireSellerJwt, async (req: Request, res: Response) => {
  const sellerWallet = req.sellerAuth?.sellerWallet;
  if (!sellerWallet) return res.status(401).json({ error: 'Invalid seller token' });

  const { transactions } = await getSellerDashboardData(sellerWallet);
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
datasetsRouter.get('/:id', async (req: Request, res: Response) => {
  const dataset = await getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
  const meta = withoutRawData(dataset);
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
datasetsRouter.get('/:id/transactions', requireSellerJwt, async (req: Request, res: Response) => {
  const dataset = await getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
  if (dataset.sellerWallet !== req.sellerAuth?.sellerWallet) {
    return res.status(403).json({ error: 'Dataset does not belong to authenticated seller' });
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  const transactions = await getTransactions(req.params.id, limit, offset);
  const total = await getTransactionsCount(req.params.id);

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
datasetsRouter.post(
  '/',
  requireApiKey,
  validateBody(createDatasetSchema),
  async (req: Request, res: Response) => {
    const { name, description, type, pricePerQuery, sellerWallet, data } = req.body as z.infer<
      typeof createDatasetSchema
    >;

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

    await addDataset(dataset);

    // Notify seller via webhook
    notifySeller(dataset.sellerWallet, 'dataset.created', {
      datasetId: dataset.id,
      datasetName: dataset.name,
      type: dataset.type,
      pricePerQuery: dataset.pricePerQuery,
    }).catch(() => {});

    const { data: _d, ...meta } = dataset;
    return res.status(201).json({ success: true, dataset: meta });
  },
);
