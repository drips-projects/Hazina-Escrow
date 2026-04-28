const REQUEST_THROTTLE_MS = 250;

const requestQueues = new Map<string, Promise<void>>();
const requestStartedAt = new Map<string, number>();

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function getRequestKey(url: string, options?: RequestInit) {
  const method = (options?.method ?? 'GET').toUpperCase();
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const { pathname } = new URL(url, origin);
  return `${method}:${pathname}`;
}

async function scheduleRequest<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = requestQueues.get(key) ?? Promise.resolve();

  const scheduled = previous.then(async () => {
    const lastStarted = requestStartedAt.get(key) ?? 0;
    const elapsed = Date.now() - lastStarted;

    if (elapsed < REQUEST_THROTTLE_MS) {
      await sleep(REQUEST_THROTTLE_MS - elapsed);
    }

    requestStartedAt.set(key, Date.now());
    return task();
  });

  const tracked = scheduled.then(
    () => undefined,
    () => undefined,
  );

  requestQueues.set(key, tracked);

  return scheduled.finally(() => {
    if (requestQueues.get(key) === tracked) {
      requestQueues.delete(key);
    }
  });
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const AGENT_REQUEST_TIMEOUT_MS = 120_000;

const RAW_API_URL = (import.meta.env.VITE_API_URL ?? '').toString().trim();
export const API_BASE_URL = RAW_API_URL
  ? `${RAW_API_URL.replace(/\/+$/, '')}/api`
  : '/api';

const BASE = API_BASE_URL;
const API_KEY = (import.meta.env.VITE_API_KEY ?? '').toString().trim();

// ── Public interfaces ──────────────────────────────────────────────────────

export interface AgentSellerPayment {
  seller: string;
  type: string;
  amount: number;
  txHash: string;
  onChain: boolean;
}

export interface AgentReport {
  topOpportunity: {
    protocol: string;
    vault: string;
    chain: string;
    apy: number;
    riskLevel: string;
    whaleConfidence: string;
    sentimentScore: string;
  };
  reasoning: string;
  alternatives: string[];
  warnings: string[];
  rawAnalysis: string;
}

export interface AgentJob {
  success: boolean;
  demo?: boolean;
  jobId: string;
  query: string;
  report: AgentReport;
  payments: {
    humanPaid: number;
    currency: string;
    network: string;
    note?: string;
    sellerPayments: AgentSellerPayment[];
    totalSpent: number;
    agentProfit: number;
  };
  meta: {
    agentWallet: string;
    timestamp: string;
    datasetsQueried: number;
  };
}

export interface AgentInfo {
  success: boolean;
  agent: {
    name: string;
    version: string;
    description: string;
    agentWallet: string;
    fee: { amount: number; currency: string; network: string; description: string };
    sellers: { type: string; role: string; cost: number }[];
    agentProfit: number;
    escrowWallet: string;
  };
}

export interface DatasetMeta {
  id: string;
  name: string;
  description: string;
  type: string;
  pricePerQuery: number;
  sellerWallet: string;
  queriesServed: number;
  totalEarned: number;
  createdAt: string;
  thumbnail?: string;
}

export interface Transaction {
  id: string;
  datasetId: string;
  txHash: string;
  amount: number;
  buyerQuery?: string;
  aiSummary?: string;
  timestamp: string;
}

export interface Stats {
  totalDatasets: number;
  totalQueries: number;
  totalUsdcEarned: number;
  totalTransactions: number;
}

export interface PaginatedDatasets {
  data: DatasetMeta[];
  total: number;
  page: number;
  totalPages: number;
}

export interface QueryResult {
  success: boolean;
  demo?: boolean;
  data: Record<string, unknown>;
  ai: { summary: string; answer?: string };
  transaction: {
    hash: string;
    amount: number;
    sellerReceived: number;
    platformFee: number;
  };
}


interface RequestOptions extends RequestInit {
  /** Per-call override of the abort timeout, in milliseconds. */
  timeoutMs?: number;
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  return { ...headers, ...(extra as Record<string, string>) };
}

async function fetchWithTimeout(url: string, options?: RequestOptions): Promise<Response> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...init } = options ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: authHeaders(init.headers),
      ...init,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out — please try again');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Runtime response validation ────────────────────────────────────────────
// Lightweight guards that validate critical API response shapes at runtime.
// They throw a descriptive ApiValidationError when the server returns
// unexpected data, preventing silent undefined/null crashes downstream.

export class ApiValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = "ApiValidationError";
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new ApiValidationError(`Expected string for "${field}", got ${typeof value}`, field);
  }
}

function assertNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiValidationError(`Expected finite number for "${field}", got ${typeof value}`, field);
  }
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new ApiValidationError(`Expected array for "${field}", got ${typeof value}`, field);
  }
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiValidationError(`Expected object for "${field}", got ${typeof value}`, field);
  }
}

/** Validate a Stats object from the API. */
function validateStats(raw: unknown): Stats {
  assertObject(raw, "stats");
  assertNumber(raw.totalDatasets, "stats.totalDatasets");
  assertNumber(raw.totalQueries, "stats.totalQueries");
  assertNumber(raw.totalUsdcEarned, "stats.totalUsdcEarned");
  assertNumber(raw.totalTransactions, "stats.totalTransactions");
  return raw as unknown as Stats;
}

/** Validate a DatasetMeta object from the API. */
function validateDataset(raw: unknown, index?: number): DatasetMeta {
  const label = index !== undefined ? `dataset[${index}]` : "dataset";
  assertObject(raw, label);
  assertString(raw.id, `${label}.id`);
  assertString(raw.name, `${label}.name`);
  assertString(raw.type, `${label}.type`);
  assertNumber(raw.pricePerQuery, `${label}.pricePerQuery`);
  assertString(raw.sellerWallet, `${label}.sellerWallet`);
  return raw as unknown as DatasetMeta;
}

// ── HTTP helper ────────────────────────────────────────────────────────────

async function request<T>(url: string, options?: RequestOptions): Promise<T> {
  return scheduleRequest(getRequestKey(url, options), async () => {
    const res = await fetchWithTimeout(url, options);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Network error' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  });
}

export const api = {
  getDatasets: (params?: {
    page?: number;
    limit?: number;
    search?: string;
    type?: string;
    sort?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      if (params.page) searchParams.append('page', params.page.toString());
      if (params.limit) searchParams.append('limit', params.limit.toString());
      if (params.search) searchParams.append('search', params.search);
      if (params.type) searchParams.append('type', params.type);
      if (params.sort) searchParams.append('sort', params.sort);
    }
    const query = searchParams.toString();
    const url = `${BASE}/datasets${query ? `?${query}` : ''}`;
    return request<PaginatedDatasets>(url).then((r) => {
      assertArray(r.data, "datasets.data");
      r.data = r.data.map((item, i) => validateDataset(item, i));
      return r;
    });
  },

  getStats: () =>
    request<{ success: boolean; stats: unknown }>(`${BASE}/datasets/stats`).then((r) =>
      validateStats(r.stats),
    ),

  getDataset: (id: string) =>
    request<{ success: boolean; dataset: DatasetMeta }>(`${BASE}/datasets/${id}`).then(
      r => r.dataset,
    ),

  getTransactions: (datasetId?: string) => {
    const url = datasetId
      ? `${BASE}/datasets/${datasetId}/transactions`
      : `${BASE}/datasets/transactions`;
    return request<{ success: boolean; transactions: Transaction[] }>(url).then(
      r => r.transactions,
    );
  },

  initiateQuery: (id: string) =>
    request<{ payment: { paymentAddress: string; amount: number; memo: string } }>(
      `${BASE}/query/${id}`,
      { method: 'POST' },
    ),

  verifyPayment: (id: string, txHash: string, buyerQuestion?: string) =>
    request<QueryResult>(`${BASE}/verify/${id}`, {
      method: 'POST',
      body: JSON.stringify({ txHash, buyerQuestion }),
    }),

  demoQuery: (id: string, buyerQuestion?: string) =>
    request<QueryResult>(`${BASE}/verify/${id}/demo`, {
      method: 'POST',
      body: JSON.stringify({ buyerQuestion }),
    }),

  agentInfo: () => request<AgentInfo>(`${BASE}/agent/info`),

  agentDemo: (query: string) =>
    request<AgentJob>(`${BASE}/agent/research/demo`, {
      method: 'POST',
      body: JSON.stringify({ query }),
      timeoutMs: AGENT_REQUEST_TIMEOUT_MS,
    }),

  agentResearch: (query: string, txHash: string) =>
    request<AgentJob>(`${BASE}/agent/research`, {
      method: 'POST',
      body: JSON.stringify({ query, txHash }),
      timeoutMs: AGENT_REQUEST_TIMEOUT_MS,
    }),

  createDataset: (payload: {
    name: string;
    description: string;
    type: string;
    pricePerQuery: number;
    sellerWallet: string;
    data: unknown;
  }) =>
    request<{ success: boolean; dataset: DatasetMeta }>(`${BASE}/datasets`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    }).then(r => r.dataset),
};

export function __resetRequestThrottleForTests() {
  requestQueues.clear();
  requestStartedAt.clear();
}
