# OpenAI LLM Agent Usage

## Environment

Set these variables before starting the server:

```powershell
$env:OPENAI_API_KEY = "<redacted>"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_MODEL = "<your-openai-model>"
$env:OPENAI_TIMEOUT_MS = "30000"
```

Do not commit real API keys. `OPENAI_BASE_URL` exists for proxies and compatible gateways; leave it unset for the official OpenAI API.

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
