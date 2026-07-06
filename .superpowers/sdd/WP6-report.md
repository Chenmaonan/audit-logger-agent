# WP6 Report: LLM 预算与缓存护栏

## Status

DONE

## Summary

- Added `auditReview.llmBudget` config defaults for daily call limit, daily estimated token limit, max concurrency, and detail-analysis caching.
- Added durable finding detail LLM analysis cache fields on `audit_review_findings` with legacy-table migration support.
- Added `audit_llm_usage(day, calls, est_tokens, updated_at)` tracking and store APIs for reading/updating daily usage.
- Updated finding detail analysis to reuse fresh cached analysis and write cache after successful LLM analysis.
- Added scheduler budget checks before review LLM calls. When exhausted, scheduler skips the LLM, logs `review.llm.budget_exceeded`, finishes degraded, and persists rule-based findings.
- Added OpenAI Responses client concurrency gating with default max concurrency 2 and server wiring from config.

## Tests

- Focused:
  - `node --test test/auditReview/reviewStore.test.js` - passed 18/18
  - `node --test test/auditReview/visualization.test.js` - passed 12/12
  - `node --test test/auditReview/scheduler.test.js` - passed 10/10
  - `node --test test/llm/openaiConfig.test.js test/llm/openaiResponsesClient.test.js` - passed 8/8
- Required full verification:
  - `node --test test/auditReview/*.test.js test/http/*.test.js test/llm/openaiConfig.test.js test/runtime/*.test.js` - passed 160/160

## Files

- `config.json`
- `scripts/server.js`
- `src/db/reviewSchema.js`
- `src/auditReview/reviewStore.js`
- `src/auditReview/scheduler.js`
- `src/auditReview/visualization.js`
- `src/llm/openaiConfig.js`
- `src/llm/openaiResponsesClient.js`
- `test/auditReview/scheduler.test.js`
- `test/auditReview/reviewStore.test.js`
- `test/auditReview/visualization.test.js`
- `test/llm/openaiConfig.test.js`
- `test/llm/openaiResponsesClient.test.js`

## Concerns

- Worktree contains unrelated WP3/WP4 changes in `config.json`, `scripts/lib/db.js`, `scripts/lib/parser.js`, `src/adapters/http/app.js`, and `src/auditReview/ingestService.js`; only WP6 hunks were staged.
- Some test files and this report are ignored by local exclude rules, so they were force-added as WP6 evidence.
