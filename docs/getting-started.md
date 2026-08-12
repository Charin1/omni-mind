# Getting Started — New Contributor Guide

> Get OmniMind running locally in under 5 minutes.

---

## Prerequisites

| Tool | Minimum Version | Check Command |
|---|---|---|
| Node.js | 20+ | `node --version` |
| npm | 10+ | `npm --version` |
| Python | 3.9+ | `python3 --version` |
| At least one LLM key | — | See below |

You need **at least one** of these configured:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- A running Ollama server at `http://localhost:11434`

---

## Step-by-Step Setup

### 1. Clone & Configure

```bash
git clone <repo-url>
cd omni-mind
cp .env.example .env
# Edit .env and add your API key(s)
```

### 2. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Start the API server:

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

> ✅ Backend is live at [http://localhost:8000](http://localhost:8000)

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

> ✅ Frontend is live at [http://localhost:3000](http://localhost:3000)

### 4. (Optional) Observability Stack

```bash
docker compose -f observability/docker-compose.yml up -d
```

> ✅ Grafana is live at [http://localhost:3001](http://localhost:3001) (no login required)

---

## Quick Orientation

Once running, here's what to explore:

1. **Chat** — Send a message using any configured provider
2. **Switch Models** — Use the provider/model dropdown to swap LLMs
3. **Artifact Generation** — Say "create a docx about..." to trigger file generation
4. **Research** — Say "research the latest trends in..." to trigger deep research
5. **MCP Servers** — Open settings to register external tool servers
6. **Projects** — Create a project to group conversations with custom instructions

---

## Key Files to Read First

If you're diving into the code, read these files in order:

| Priority | File | Why |
|---|---|---|
| 1 | `backend/main.py` | App entrypoint — see all routers |
| 2 | `backend/api/chat.py` | The central hub that connects everything |
| 3 | `backend/providers/base.py` | Understand the provider interface |
| 4 | `backend/agents/graph_runtime.py` | How requests get routed |
| 5 | `backend/context/manager.py` | How context windows are managed |
| 6 | `frontend/src/lib/api.ts` | How the frontend talks to the backend |
| 7 | `frontend/src/app/page.tsx` | The entire chat UI |

---

## Common Tasks

### Add a new provider
1. Create `backend/providers/my_provider.py` extending `BaseLLMProvider`
2. Register it in `backend/providers/__init__.py`
3. Add the API key to `.env`

### Add a new tool
1. Add tool schema + implementation in `backend/tools/`
2. Wire it into the tool call loop in `backend/api/chat.py`

### Run tests
```bash
cd backend
source .venv/bin/activate
pytest tests/
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `pip: command not found` | Recreate the venv: `python3 -m venv .venv && source .venv/bin/activate` |
| Frontend can't reach backend | Check `NEXT_PUBLIC_API_BASE_URL` in `.env` (default: `http://localhost:8000`) |
| No providers available | Ensure at least one `*_API_KEY` is set in `.env` |
| ChromaDB errors | Delete `chroma_db/` folder and restart the backend |
| Port 3000 in use | Check for other Next.js apps: `lsof -i :3000` |
