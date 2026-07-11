# OmniMind Observability

Full three-signal observability for the backend, matching the classic OTel architecture:

```
backend (OpenTelemetry SDK)
        │ OTLP http :4318
        ▼
 otel-collector ──┬─▶ Prometheus  (metrics, :9090)
                  ├─▶ Tempo       (traces,  :3200)
                  └─▶ Loki        (logs,    :3100)
                            │
                         Grafana  (:3001, anonymous admin)
```

## Run

```bash
docker compose -f observability/docker-compose.yml up -d
```

Then start the backend as usual — it auto-detects the collector at
`http://localhost:4318`. Open **http://localhost:3001** → dashboard
**OmniMind — LLM & Agent Observability** (provisioned automatically).

If the collector isn't running, the backend still works; exports just fail
quietly in the background. Disable entirely with `OTEL_ENABLED=false`.

## What's instrumented

| Signal | Source |
|---|---|
| Traces | FastAPI server spans, outbound httpx (LLM/tool calls), SQLAlchemy queries |
| Metrics | `omnimind_chat_requests_total`, `omnimind_chat_ttft_seconds`, `omnimind_chat_duration_seconds`, `omnimind_chat_tokens_total` (input/output), `omnimind_active_streams`, `omnimind_tool_calls_total`, `omnimind_tool_duration_seconds`, `omnimind_mcp_connects_total`, `omnimind_memory_retrievals_total`, `omnimind_research_tasks_total` + HTTP/DB auto-metrics |
| Logs | All backend logging (incl. uvicorn.error) bridged to OTLP → Loki |

Domain metric helpers live in `backend/observability/metrics.py`; setup in
`backend/observability/telemetry.py`.

## Env vars (backend)

| Var | Default | Purpose |
|---|---|---|
| `OTEL_ENABLED` | `true` | Master switch |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Collector OTLP/HTTP endpoint |
| `OTEL_SERVICE_NAME` | `omnimind-backend` | Service name on all signals |
| `OTEL_METRIC_EXPORT_INTERVAL_MS` | `10000` | Metric push interval |
