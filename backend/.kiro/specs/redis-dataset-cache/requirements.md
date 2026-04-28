# Requirements Document

## Introduction

This feature adds a Redis caching layer to the Hazina Data Escrow backend to reduce repeated file I/O on hot read paths. The three most expensive read paths — listing all datasets, fetching platform stats, and fetching a single dataset by ID — currently call `readStore()` (a synchronous `fs.readFileSync`) on every request. The agent service also calls `getAllDatasets()` on every research job. The cache service must degrade gracefully when Redis is unavailable, falling through to the existing storage layer transparently.

## Glossary

- **Cache_Service**: The module at `backend/src/common/cache.ts` that wraps `ioredis` and exposes typed get/set/delete helpers.
- **Storage_Layer**: The existing module at `backend/src/common/storage.ts` that reads and writes `data/datasets.json`.
- **Cache_Key**: A namespaced string used to identify a cached value in Redis (e.g. `haz:datasets:all`, `haz:dataset:{id}`).
- **TTL**: Time-to-live in seconds; the duration a cached value remains valid before Redis evicts it automatically.
- **Cache_Miss**: A lookup that finds no value in Redis, causing a fall-through to the Storage_Layer.
- **Cache_Hit**: A lookup that returns a value from Redis without touching the Storage_Layer.
- **Invalidation**: The act of deleting one or more Cache_Keys from Redis so subsequent reads fetch fresh data from the Storage_Layer.
- **Graceful_Degradation**: The behaviour where the system continues to function correctly using the Storage_Layer when Redis is unavailable or returns an error.
- **REDIS_URL**: The environment variable that provides the Redis connection string (e.g. `redis://localhost:6379`).

---

## Requirements

### Requirement 1: Cache Service Module

**User Story:** As a backend developer, I want a dedicated cache service module, so that all Redis interactions are centralised and the rest of the codebase does not depend directly on the Redis client.

#### Acceptance Criteria

1. THE Cache_Service SHALL expose a `get<T>(key: string): Promise<T | null>` function that returns the parsed JSON value for the given Cache_Key, or `null` on a Cache_Miss.
2. THE Cache_Service SHALL expose a `set(key: string, value: unknown, ttlSeconds: number): Promise<void>` function that serialises the value as JSON and stores it in Redis with the given TTL.
3. THE Cache_Service SHALL expose a `del(...keys: string[]): Promise<void>` function that deletes one or more Cache_Keys atomically.
4. WHEN `REDIS_URL` is set in the environment, THE Cache_Service SHALL connect to Redis using that URL on first use.
5. IF `REDIS_URL` is not set, THEN THE Cache_Service SHALL operate in a no-op mode where `get` always returns `null`, `set` is a no-op, and `del` is a no-op.
6. IF a Redis operation throws an error, THEN THE Cache_Service SHALL log the error and return `null` (for `get`) or resolve silently (for `set` and `del`), without propagating the exception to the caller.
7. THE Cache_Service SHALL expose a `disconnect(): Promise<void>` function for graceful shutdown.

---

### Requirement 2: Cache Key and TTL Strategy

**User Story:** As a backend developer, I want well-defined cache keys and TTLs for each cached resource, so that cache entries are predictable, debuggable, and expire at appropriate intervals.

#### Acceptance Criteria

1. THE Cache_Service SHALL define a `CacheKeys` constant object that exposes the following key factories:
   - `CacheKeys.datasetList()` → `"haz:datasets:all"`
   - `CacheKeys.dataset(id: string)` → `"haz:dataset:{id}"`
   - `CacheKeys.stats()` → `"haz:stats"`
2. THE Cache_Service SHALL define a `CacheTTL` constant object with the following values:
   - `CacheTTL.DATASET_LIST` = 60 seconds
   - `CacheTTL.DATASET` = 120 seconds
   - `CacheTTL.STATS` = 30 seconds
3. WHEN a Cache_Key is constructed using `CacheKeys.dataset(id)`, THE Cache_Service SHALL include the dataset ID verbatim in the key string.

---

### Requirement 3: Cached Read Paths in Storage Layer

**User Story:** As a backend developer, I want the hot read functions in the storage layer to use the cache transparently, so that repeated reads are served from Redis without changing the call sites in routers or services.

#### Acceptance Criteria

1. WHEN `getAllDatasets()` is called and a Cache_Hit occurs, THE Storage_Layer SHALL return the cached dataset array without reading `datasets.json`.
2. WHEN `getAllDatasets()` is called and a Cache_Miss occurs, THE Storage_Layer SHALL read from `datasets.json`, store the result in Redis using `CacheKeys.datasetList()` and `CacheTTL.DATASET_LIST`, and return the result.
3. WHEN `getDataset(id)` is called and a Cache_Hit occurs, THE Storage_Layer SHALL return the cached Dataset object without reading `datasets.json`.
4. WHEN `getDataset(id)` is called and a Cache_Miss occurs, THE Storage_Layer SHALL read from `datasets.json`, store the result in Redis using `CacheKeys.dataset(id)` and `CacheTTL.DATASET`, and return the result.
5. WHEN `getTransactions()` is called with no arguments (stats path), THE Storage_Layer SHALL cache the result using `CacheKeys.stats()` and `CacheTTL.STATS`.
6. IF the Cache_Service is in no-op mode or returns an error, THEN THE Storage_Layer SHALL fall through to `datasets.json` reads transparently, with no change in return value or thrown exceptions.

---

### Requirement 4: Cache Invalidation on Writes

**User Story:** As a backend developer, I want cache entries to be invalidated whenever datasets are written, so that readers never see stale data after a write operation.

#### Acceptance Criteria

1. WHEN `addDataset()` is called, THE Storage_Layer SHALL delete `CacheKeys.datasetList()` and `CacheKeys.stats()` from Redis after the write to `datasets.json` succeeds.
2. WHEN `updateDataset()` is called, THE Storage_Layer SHALL delete `CacheKeys.dataset(id)`, `CacheKeys.datasetList()`, and `CacheKeys.stats()` from Redis after the write to `datasets.json` succeeds.
3. IF cache invalidation fails (Redis error), THEN THE Storage_Layer SHALL log the error and continue without throwing, so the write operation is not rolled back.
4. WHEN `addTransaction()` is called, THE Storage_Layer SHALL delete `CacheKeys.stats()` from Redis after the write succeeds, because transaction counts affect the stats endpoint.

---

### Requirement 5: Environment Configuration

**User Story:** As a DevOps engineer, I want Redis to be configured via a single environment variable, so that the connection can be changed per environment without code changes.

#### Acceptance Criteria

1. THE Cache_Service SHALL read the Redis connection string exclusively from the `REDIS_URL` environment variable.
2. WHEN `REDIS_URL` is absent or empty, THE Cache_Service SHALL log a single informational message at startup indicating that caching is disabled.
3. THE Cache_Service SHALL NOT require any other environment variables for basic operation.

---

### Requirement 6: Graceful Degradation

**User Story:** As a site reliability engineer, I want the API to continue serving requests correctly when Redis is down, so that a Redis outage does not cause an API outage.

#### Acceptance Criteria

1. WHEN Redis becomes unavailable after initial connection, THE Cache_Service SHALL catch all subsequent Redis errors and treat them as Cache_Misses.
2. WHILE Redis is unavailable, THE Storage_Layer SHALL serve all reads directly from `datasets.json` with no change in response shape or HTTP status codes.
3. WHEN Redis reconnects, THE Cache_Service SHALL resume normal caching behaviour automatically without requiring a server restart.
4. IF a `get` call to Redis times out or throws, THEN THE Cache_Service SHALL return `null` within the same request cycle so the caller can fall through to storage.

---

### Requirement 7: Tests

**User Story:** As a developer, I want comprehensive tests for the cache service and the cached storage functions, so that I can verify correctness and catch regressions.

#### Acceptance Criteria

1. THE Cache_Service tests SHALL mock the Redis client so no real Redis instance is required during testing.
2. WHEN `get` is called with a key that exists in the mock, THE Cache_Service SHALL return the correct deserialised value.
3. WHEN `get` is called with a key that does not exist, THE Cache_Service SHALL return `null`.
4. WHEN the Redis client throws during `get`, THE Cache_Service SHALL return `null` without throwing.
5. WHEN the Redis client throws during `set`, THE Cache_Service SHALL resolve without throwing.
6. WHEN `getAllDatasets()` is called twice in succession with a warm cache, THE Storage_Layer SHALL read `datasets.json` exactly once.
7. WHEN `addDataset()` is called, THE Storage_Layer SHALL invalidate `CacheKeys.datasetList()` and `CacheKeys.stats()`.
8. WHEN `updateDataset()` is called, THE Storage_Layer SHALL invalidate `CacheKeys.dataset(id)`, `CacheKeys.datasetList()`, and `CacheKeys.stats()`.
