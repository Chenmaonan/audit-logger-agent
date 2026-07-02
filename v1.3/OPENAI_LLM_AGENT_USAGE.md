# OpenAI LLM Agent Usage

## Configuration

LLM credentials are read from a project-level `.config` file (JSON) at the repo root. Copy the example file and fill in your values:

```powershell
Copy-Item .config.example .config
```

`.config` shape:

```json
{
  "AUDIT_AGENT_LLM_API_KEY": "<your-api-key>",
  "AUDIT_AGENT_LLM_BASE_URL": "https://api.openai.com/v1",
  "AUDIT_AGENT_LLM_MODEL": "<your-model>",
  "AUDIT_AGENT_LLM_TIMEOUT_MS": "30000"
}
```

`.config` is git-ignored and must never contain real keys in commits. You may instead set process environment variables with the same names — environment values override `.config`. `AUDIT_AGENT_LLM_BASE_URL` exists for proxies and compatible gateways; leave it at the default for the official OpenAI API.

## Start Server

```powershell
node scripts/server.js --port 9320
```

## Create Run

```powershell
$body = @{
  channel = "feishu"
  conversation_id = "oc_manual"
  message_id = "om_manual_openai"
  user = @{ open_id = "ou_manual" }
  request = @{ text = "Analyze all audit failures and summarize the riskiest traces" }
  delivery = @{ mode = "callback"; callback_url = "http://127.0.0.1:9999/agent-events" }
  metadata = @{ tenant_key = "tenant_manual" }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Uri "http://127.0.0.1:9320/v1/runs" -Method Post -ContentType "application/json" -Body $body
```

## Check Run

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9320/v1/runs/<run_id>" -Method Get
```

## Expected Behavior

- The server returns `202` quickly.
- The planner calls OpenAI through the configured Responses API endpoint.
- The LLM returns a structured plan.
- The existing runtime executes local tools.
- Progress and final result events are stored in `agent_outbox_events`.
- Runtime lifecycle events are stored in `audit_events`.
