# agent-audit-log Specification v1.0

Language-agnostic structured audit log format for AI agent tool invocations.

## File Format

- **Container**: NDJSON (newline-delimited JSON), one JSON object per line
- **Extension**: `.jsonl`
- **Encoding**: UTF-8
- **File naming**: `audit-YYYY-MM-DD.jsonl` (rotated daily)

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string (ISO 8601) | Timestamp with timezone offset, e.g. `"2026-07-02T14:30:00.123+08:00"` |
| `agent_id` | string | Agent instance identifier, e.g. `"rental-price-agent"`, `"mt-agent"` |
| `trace_id` | string (UUID v4) | Groups all events within one logical operation (batch run, user request, etc.) |
| `span_id` | string (UUID v4) | Unique per log line; enables parent-child span relationships |
| `event` | enum string | One of: `"tool.start"`, `"tool.end"`, `"tool.error"`, `"agent.start"`, `"agent.end"`, `"agent.error"` |
| `tool_name` | string | Fully qualified tool/action name, e.g. `"rental.read"`, `"publicTraffic.runReport"` |
| `status` | enum string | One of: `"ok"`, `"error"`, `"timeout"`, `"cancelled"` |
| `result_summary` | string | One-line human-readable summary, max 200 characters |

## Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `parent_span_id` | string (UUID v4) | Parent span for nested/causal operations |
| `duration_ms` | number | Elapsed milliseconds (meaningful on `tool.end` / `agent.end`) |
| `input` | object | Tool input parameters — secrets must be redacted, truncated at 1KB |
| `output` | object | Tool output summary — truncated at 1KB |
| `error` | object | `{ "code": string, "message": string, "stack?": string }` — only when status is `"error"` |
| `channel` | string | Invocation channel: `"cli"`, `"http"`, `"feishu"`, `"cron"`, `"webhook"` |
| `user_id` | string | Initiator identifier (Feishu user ID, CLI user, `"system"`) |
| `product_id` | string | Business entity ID relevant to the operation |
| `tags` | string[] | Free-form tags for filtering, e.g. `["batch", "price-change"]` |

## Event Semantics

- **`tool.start`** — emitted immediately before tool execution begins
- **`tool.end`** — emitted after successful tool completion; must include `duration_ms`
- **`tool.error`** — emitted when a tool throws or fails; must include `error` object
- **`agent.start`** — emitted at agent/operation startup (batch run, request handling)
- **`agent.end`** — emitted at agent/operation completion
- **`agent.error`** — emitted when the agent itself encounters a fatal error

## Span Model

Every `tool.start` should have a corresponding `tool.end` or `tool.error` with the same `span_id`. Nested operations use `parent_span_id` to reference their parent span. The `trace_id` ties all spans of one logical operation together.

```
agent.start (span_id=A, trace_id=T)
  tool.start (span_id=B, parent_span_id=A, trace_id=T)
  tool.end   (span_id=B, parent_span_id=A, trace_id=T)
  tool.start (span_id=C, parent_span_id=A, trace_id=T)
  tool.end   (span_id=C, parent_span_id=A, trace_id=T)
agent.end   (span_id=A, trace_id=T)
```

## Example

```jsonl
{"ts":"2026-07-02T14:30:00.100+08:00","agent_id":"rental-price-agent","trace_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","span_id":"b1c2d3e4-f5a6-7890-bcde-f12345678901","event":"agent.start","tool_name":"batch.execute","status":"ok","result_summary":"Batch execution started: 3 products","channel":"cli","tags":["batch"]}
{"ts":"2026-07-02T14:30:00.200+08:00","agent_id":"rental-price-agent","trace_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","span_id":"c1d2e3f4-a5b6-7890-cdef-123456789012","parent_span_id":"b1c2d3e4-f5a6-7890-bcde-f12345678901","event":"tool.start","tool_name":"rental.read","status":"ok","result_summary":"Reading product 761","channel":"http","product_id":"761","tags":["read","batch"]}
{"ts":"2026-07-02T14:30:01.434+08:00","agent_id":"rental-price-agent","trace_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","span_id":"c1d2e3f4-a5b6-7890-cdef-123456789012","parent_span_id":"b1c2d3e4-f5a6-7890-bcde-f12345678901","event":"tool.end","tool_name":"rental.read","status":"ok","result_summary":"Read product 761: price=99.00, stock=50","duration_ms":1234,"channel":"http","product_id":"761","tags":["read","batch"]}
{"ts":"2026-07-02T14:30:05.000+08:00","agent_id":"rental-price-agent","trace_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","span_id":"b1c2d3e4-f5a6-7890-bcde-f12345678901","event":"agent.end","tool_name":"batch.execute","status":"ok","result_summary":"Batch complete: 3/3 products updated","duration_ms":4900,"channel":"cli","tags":["batch"]}
```

## Implementation Notes

### For Node.js agents
Use the provided `audit-logger.js` module. It handles file rotation, UUID generation, and ISO timestamp formatting.

### For Python agents
```python
import json, uuid
from datetime import datetime, timezone

def log_event(log_dir, agent_id, **fields):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    path = f"{log_dir}/audit-{today}.jsonl"
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_id,
        "trace_id": fields.get("trace_id", str(uuid.uuid4())),
        "span_id": str(uuid.uuid4()),
        **fields
    }
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
```

### For any language
The format is plain NDJSON. Any language with JSON and file I/O can emit it. The only requirement is that each line is a valid JSON object with the required fields.
