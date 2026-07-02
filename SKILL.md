# Audit Logger Agent

## Purpose
Ingest, index, query, and report on structured audit logs emitted by other agents (rental-price-agent, MT-agent, and future agents). Provides a unified audit trail across all agent tool invocations.

## Log Format
Agents must emit NDJSON (`.jsonl`) files conforming to the `agent-audit-log` specification. See `LOG_SPEC.md` for the full field reference.

## Available Actions

### ingest
Scan configured log directories, parse NDJSON files, deduplicate by `span_id`, and index into the local SQLite database.

```
node scripts/ingest.js [--since YYYY-MM-DD]
```

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
  --agent-id <id>            Filter by agent
```

### server
Start an HTTP API server for live querying.

```
node scripts/server.js [--port 9320]
```

Endpoints:
- `GET /query?agent_id=...&tool_name=...&from=...&to=...&limit=100`
- `GET /report/daily?date=YYYY-MM-DD`
- `GET /report/errors?from=...&to=...`
- `GET /health`

## Configuration
Edit `config.json` to set log directory paths for each agent.

## Safety
- All operations are read-only on source log files
- The SQLite database is the only writable artifact
- No network access required (except optional server mode on localhost)
