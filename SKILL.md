# Audit Logger Agent

## Purpose
Ingest, index, query, and report on structured audit logs emitted by other agents (rental-price-agent, MT-agent, and future agents). Provides a unified audit trail across all agent tool invocations.

## Log Format
Agents must emit NDJSON (`.jsonl`) files conforming to the `agent-audit-log` specification. See `LOG_SPEC.md` for the full field reference.

## Available Actions

### ingest
Scan configured log directories, parse NDJSON files, deduplicate by `row_hash` (SHA-256 of the raw JSON line), and index into the local SQLite database. This keeps start/end/error events that share a `span_id` distinct while still preventing the same log line from being inserted twice on re-ingest.

```
node scripts/ingest.js [--since YYYY-MM-DD]
```

`--since` restricts the scan to log files whose date (parsed from the filename, e.g. `audit-2026-07-02.jsonl`) is on or after the given date. Use it to bound incremental scans.

### query
Query the audit database with flexible filters.

```
node scripts/query.js [options]
  --agent-id <id>        Filter by agent
  --tool-name <name>     Filter by tool (supports % wildcard)
  --status <status>      Filter by status (ok, error, timeout, cancelled)
  --from <ISO timestamp>  Start of time range
  --to <ISO timestamp>    End of time range
  --trace-id <id>        Filter by trace
  --product-id <id>      Filter by product
  --limit <n>            Max results (default 100)
  --format json|table    Output format (default table)
```

### report
Generate summary reports.

```
node scripts/report.js [options]
  --type daily|errors|tools  Report type
  --date YYYY-MM-DD          Date for daily report
  --from <ISO>               Start for range reports
  --to <ISO>                 End for range reports
  --agent-id <id>            Filter all report types by agent
```

### server
Start an HTTP API server for live querying.

```
node scripts/server.js [--port 9320]
```

### OpenAI-backed planner

The v1.3 planner uses OpenAI. Start the server with:

```powershell
$env:OPENAI_API_KEY = "<redacted>"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_MODEL = "<your-openai-model>"
node scripts/server.js --port 9320
```

The LLM planner uses structured output to produce either a local tool execution plan or a `decision_request`. Tool execution remains local and auditable.

Endpoints:
- `GET /query?agent_id=...&tool_name=...&from=...&to=...&limit=100`
- `GET /report/daily?date=YYYY-MM-DD`
- `GET /report/errors?from=...&to=...`
- `GET /report/tools?from=...&to=...`
- `GET /health`

## Configuration
Edit `config.json` to set log directory paths for each agent.

## Safety
- All operations are read-only on source log files
- The SQLite database is the only writable artifact
- No network access required (except optional server mode on localhost)
