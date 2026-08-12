# API Reference

> Complete REST + SSE endpoint documentation for OmniMind's backend API.

---

## Base URL

```
http://localhost:8000
```

Override with `NEXT_PUBLIC_API_BASE_URL` environment variable.

---

## Chat

### `POST /api/chat` — Stream a chat response

Streams an AI response via Server-Sent Events (SSE).

**Request body:**

```json
{
  "conversation_id": "uuid-string",
  "user_id": "local-user",
  "message": "Hello, what can you do?",
  "provider": "openai",
  "model": "gpt-4o",
  "history": [],
  "settings": {
    "system_prompt": "You are a helpful assistant.",
    "temperature": 0.7,
    "max_tokens": null,
    "enabled_tools": ["web_search", "computer_use"]
  },
  "project_id": null
}
```

**SSE Event Types:**

| Event Type | Payload | Description |
|---|---|---|
| `content` | `{content: "..."}` | Streamed text token |
| `thinking_start` | `{type: "thinking_start"}` | Model started reasoning |
| `thinking_chunk` | `{type: "thinking_chunk", content: "..."}` | Reasoning token |
| `thinking_end` | `{type: "thinking_end"}` | Reasoning complete |
| `tool_approval_request` | `{type: "tool_approval_request", approval_id, tool_name, ...}` | Needs human approval |
| `tool_approval_resolved` | `{type: "tool_approval_resolved", approval_id, approved}` | Approval resolved |
| `tool_status` | `{type: "tool_status", tool_name, status}` | Tool execution status |
| `tool_sources` | `{type: "tool_sources", tool_name, sources: [...]}` | URLs used by tools |
| `research_progress` | `{type: "research_progress", message, percentage}` | Research pipeline progress |
| `response_replace` | `{type: "response_replace", content}` | Replace streamed content |
| `tool_call_detected` | `{type: "tool_call_detected"}` | Clear streamed JSON blob |
| `error` | `{error: "..."}` | Error occurred |
| `[DONE]` | `data: [DONE]` | Stream complete |

### `GET /api/chat/providers` — List available providers

Returns providers and their models.

### `GET /api/chat/providers/{provider}/models` — List models for a provider

---

## Conversations

### `GET /api/conversations?user_id=...` — List conversations
### `GET /api/conversations/{id}` — Get conversation details
### `PATCH /api/conversations/{id}` — Update conversation (title)
### `DELETE /api/conversations/{id}` — Delete conversation

---

## Projects

### `GET /api/projects?user_id=...` — List projects
### `POST /api/projects` — Create project
### `PATCH /api/projects/{id}` — Update project
### `DELETE /api/projects/{id}` — Delete project

---

## Memory

### `GET /api/memory?user_id=...` — List user memories

---

## Artifacts

### `GET /api/artifacts?user_id=...&conversation_id=...` — List artifacts
### `GET /artifacts/{path}` — Download artifact file (static mount)

---

## Tasks (Research)

### `GET /api/tasks?user_id=...` — List research tasks

---

## MCP Servers

### `GET /api/mcp/servers` — List registered MCP servers
### `POST /api/mcp/servers` — Register a new MCP server
### `POST /api/mcp/servers/{id}/connect` — Connect to a server
### `POST /api/mcp/servers/{id}/oauth/start` — Start OAuth flow
### `DELETE /api/mcp/servers/{id}` — Remove a server
### `GET /api/mcp/tools` — List all tools from connected servers

---

## Tool Approval

### `POST /api/tool-approval` — Submit approval decision

```json
{
  "approval_id": "uuid",
  "approved": true,
  "reject_reason": null
}
```

---

## Settings

### `GET /api/settings/{key}` — Get a setting
### `PUT /api/settings/{key}` — Set a setting

```json
{
  "value": "any-json-value"
}
```
