# 10k synthetic corpus benchmark — v2 personal tier

**Generated:** 2026-05-02T21:54:15.372Z
**Corpus size:** 10000 tools (71.8 MB)
**DB:** `/tmp/v2-perf-10k.db`
**Embedder:** ollama:nomic-embed-text (768-dim)
**Storage:** SQLite + sqlite-vec + FTS5 (default FTS5/HNSW params)
**Queries:** 51 representative queries × 2 (cold + warm)

## runRRF latency (storage layer only)

| Phase | p50 | p95 | p99 |
|---|---|---|---|
| cold | 24ms | 53ms | 57ms |
| warm | 23ms | 56ms | 62ms |

## End-to-end (embed + runRRF)

| Phase | p50 | p95 | p99 |
|---|---|---|---|
| cold (Ollama embed) | 45ms | 82ms | 89ms |
| warm (cache hit) | 35ms | 68ms | 75ms |

## PRD claim vs reality

PRD target: **<200ms p95 at 10k tools** (end-to-end /discover including embed).
Result: warm p95 = **68ms** at 10k tools — **meets target**

## Notes
- All measurements local (RTX 5080 + nomic-embed-text via Ollama).
- Cold = first time the query is seen. Warm = LRU cache hit (sub-ms embed).
- runRRF time is dominated by sqlite-vec ANN search + FTS5 BM25, both done in C in the same process.
- No FTS5 (k1, b) or vec0 HNSW (M, ef_construction, ef_search) tuning yet — this is the baseline against which future tuning is measured.
