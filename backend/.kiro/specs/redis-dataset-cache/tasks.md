# Implementation Plan: Redis Dataset Cache

## Overview

Implement a Redis caching layer for the Hazina Data Escrow backend. The work is split into three phases: (1) install dependencies and build the cache service module, (2) augment the storage layer with cache-aside reads and write invalidation, (3) wire up tests.

## Tasks

- [ ] 1. Install ioredis and fast-check dependencies
  - Run `npm install ioredis` and `npm install --save-dev @types/ioredis @fast-check/vitest fast-check` in `backend/`
  - Verify TypeScript types resolve correctly
  - _Requirements: 1.4, 5.1_

- [ ] 2. Implement `backend/src/common/cache.ts`
  - [ ] 2.1 Create the cache module with CacheKeys, CacheTTL, and no-op mode
    - Export `CacheKeys` object with `datasetList()`, `dataset(id)`, and `stats()` factory functions
    - Export `CacheTTL` constants: `DATASET_LIST = 60`, `DATASET = 120`, `STATS = 30`
    - When `REDIS_URL` is absent, log one info message and export no-op `get`/`set`/`del`/`disconnect`
    - _Requirements: 1.5, 2.1, 2.2, 2.3, 5.1, 5.2, 5.3_
  - [ ] 2.2 Implement the ioredis client with graceful degradation options
    - Lazy singleton: create the client on first use via a `getClient()` helper
    - Use options: `lazyConnect: true`, `enableOfflineQueue: false`, `maxRetriesPerRequest: 0`, `connectTimeout: 2000`
    - Attach `client.on('error', ...)` listener to prevent unhandled-rejection crashes
    - _Requirements: 1.4, 1.6, 6.1, 6.3, 6.4_
  - [ ] 2.3 Implement `get<T>`, `set`, `del`, and `disconnect` helpers
    - `get`: call `client.get(key)`, parse JSON, return `null` on miss or any error
    - `set`: call `client.setex(key, ttlSeconds, JSON.stringify(value))`, swallow errors
    - `del`: call `client.del(...keys)`, swallow errors
    - `disconnect`: call `client.quit()` if client exists
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.7_
  - [ ]* 2.4 Write unit tests for cache.ts (`backend/src/common/cache.test.ts`)
    - Mock ioredis with `vi.mock('ioredis', ...)` returning a stub with `get`, `setex`, `del`, `quit` as `vi.fn()`
    - Test: `get` returns deserialised value on hit
    - Test: `get` returns `null` on miss (Redis returns `null`)
    - Test: `get` returns `null` when Redis throws
    - Test: `set` calls `setex` with correct key, TTL, and JSON string
    - Test: `set` resolves silently when Redis throws
    - Test: `del` calls Redis `del` with all provided keys
    - Test: no-op mode — `get` returns `null`, `set`/`del` resolve without calling Redis
    - **Property 3: No-op mode get always returns null** — `test.prop` with arbitrary key strings
    - **Property 4: Graceful degradation on Redis error** — `test.prop` with arbitrary keys/values, Redis stub throws
    - **Property 5: Cache key contains dataset ID** — `test.prop` with arbitrary non-empty ID strings
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 3. Checkpoint — cache module complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Augment `backend/src/common/storage.ts` with cache-aside reads
  - [ ] 4.1 Add cache-aside to `getAllDatasets()`
    - Import `get`, `set`, `CacheKeys`, `CacheTTL` from `./cache`
    - On cache hit: return parsed `Dataset[]` directly
    - On cache miss: call `readStore().datasets`, call `set(CacheKeys.datasetList(), datasets, CacheTTL.DATASET_LIST)`, return datasets
    - _Requirements: 3.1, 3.2, 3.6_
  - [ ] 4.2 Add cache-aside to `getDataset(id)`
    - On cache hit: return parsed `Dataset` directly
    - On cache miss: call `readStore().datasets.find(...)`, call `set(CacheKeys.dataset(id), dataset, CacheTTL.DATASET)` if found, return result
    - _Requirements: 3.3, 3.4, 3.6_
  - [ ] 4.3 Add cache-aside to `getTransactions()` for the no-argument (stats) path
    - Only cache when called with no `datasetId` argument
    - Cache key: `CacheKeys.stats()`, TTL: `CacheTTL.STATS`
    - Cache the raw `Transaction[]` array (not the computed stats object)
    - _Requirements: 3.5, 3.6_
  - [ ]* 4.4 Write property tests for cached read paths (`backend/src/common/storage-cache.test.ts`)
    - Mock `./cache` module with `vi.mock('./cache', ...)` returning controllable stubs
    - **Property 6: Cache hit avoids file system read** — `test.prop` with arbitrary `Dataset[]`; seed mock cache; assert `readStore` spy called 0 times on second call
    - **Property 7: Cache miss populates cache** — `test.prop` with arbitrary `Dataset[]`; empty mock cache; assert `set` called with `CacheKeys.datasetList()` after first call
    - **Property 8: Storage graceful degradation** — `test.prop` with arbitrary `Dataset[]`; mock `get` returns `null`; assert `getAllDatasets()` still returns correct data
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 7.6_

- [ ] 5. Augment `backend/src/common/storage.ts` with cache invalidation on writes
  - [ ] 5.1 Add invalidation to `addDataset()`
    - After `writeStore(store)` succeeds, call `del(CacheKeys.datasetList(), CacheKeys.stats())`
    - Wrap `del` call in try/catch; log error but do not re-throw
    - _Requirements: 4.1, 4.3_
  - [ ] 5.2 Add invalidation to `updateDataset()`
    - After `writeStore(store)` succeeds, call `del(CacheKeys.dataset(id), CacheKeys.datasetList(), CacheKeys.stats())`
    - Wrap `del` call in try/catch; log error but do not re-throw
    - _Requirements: 4.2, 4.3_
  - [ ] 5.3 Add invalidation to `addTransaction()`
    - After `writeStore(store)` succeeds, call `del(CacheKeys.stats())`
    - Wrap `del` call in try/catch; log error but do not re-throw
    - _Requirements: 4.4, 4.3_
  - [ ]* 5.4 Write property tests for cache invalidation (`backend/src/common/storage-cache.test.ts` additions)
    - **Property 9: addDataset invalidates list and stats** — `test.prop` with arbitrary `Dataset`; assert `del` spy called with `CacheKeys.datasetList()` and `CacheKeys.stats()`
    - **Property 10: updateDataset invalidates individual, list, and stats** — `test.prop` with arbitrary dataset ID + updates; assert `del` spy called with all three keys
    - **Property 11: addTransaction invalidates stats** — `test.prop` with arbitrary `Transaction`; assert `del` spy called with `CacheKeys.stats()`
    - **Property 12: Invalidation failure does not propagate** — `test.prop` with arbitrary write inputs; mock `del` to throw; assert write function resolves without throwing
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 7.7, 7.8_

- [ ] 6. Final checkpoint — Ensure all tests pass
  - Run `npm test` in `backend/`; ensure all existing tests still pass alongside new tests
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each property test should run a minimum of 100 iterations (fast-check default is 100)
- Tag each property test with a comment: `// Feature: redis-dataset-cache, Property N: <title>`
- The `storage.ts` functions become `async` only where cache calls are added; callers in routers and agent service must be updated to `await` those calls
- `REDIS_URL` example: `redis://localhost:6379` or `rediss://user:pass@host:6380` for TLS
