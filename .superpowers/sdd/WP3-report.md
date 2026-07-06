# WP3 Report: Audit Input Size Guards

## Status

Implemented and verified.

## Summary

- Added top-level `limits` config defaults:
  - `maxLineBytes`: 65536
  - `maxChunkBytes`: 16777216
  - `maxQueryLimit`: 1000
  - `maxBodyBytes`: 1048576
- Added NDJSON parser line-size rejection before `JSON.parse`.
- Added incremental ingest chunk-size limiting and cursor continuation across repeated ingest runs.
- Avoided unbounded append allocation by capping `readIncrementalChunk` reads to `maxChunkBytes`.
- Clamped DB query `limit` to `1..maxQueryLimit`, with default limit `100`.
- Clamped HTTP query/list `limit` and `offset` consistently.
- Enforced HTTP JSON body `maxBodyBytes` for runtime POST routes and mapped oversized bodies to `413`.

## Files Changed

- `config.json`
- `scripts/lib/parser.js`
- `scripts/lib/db.js`
- `src/auditReview/ingestService.js`
- `src/adapters/http/app.js`
- `test/auditReview/inputLimits.test.js`
- `test/http/query-limits.test.js`
- `test/http/runs-api.test.js`

## Tests

Focused tests:

- `node --test test/auditReview/inputLimits.test.js`
  - Result: pass, 4/4 tests.
- `node --test test/http/query-limits.test.js`
  - Result: pass, 1/1 tests.
- `node --test test/http/runs-api.test.js`
  - Result: pass, 2/2 tests.
- `node --test test/auditReview/ingestService.test.js`
  - Result: pass, 5/5 tests.
- `node --test test/http/ingest-route.test.js`
  - Result: pass, 10/10 tests.
- `node --test test/runtime/fixes.test.js`
  - Result: pass, 9/9 tests.

Full required verification:

- `node --test test/auditReview/*.test.js test/http/*.test.js test/llm/openaiConfig.test.js test/runtime/*.test.js`
  - Result: pass, 160/160 tests.

## Notes

- The working tree also contained unrelated WP4/WP6 changes in retention, scheduler, visualization, review schema, LLM, and server files. They were not part of WP3 and should not be included in the WP3 commit.
- `config.json` also had an unrelated `auditReview.llmBudget` hunk from another worker; only the top-level `limits` hunk belongs to WP3.
