# OmniMind

OmniMind is a full-stack chat app with a Next.js frontend and a FastAPI backend.

Current foundation features include:

- per-user conversation persistence across refreshes
- rolling conversation summaries for long chats
- user-scoped memory retrieval
- simple built-in artifact generation for `docx`, `xlsx`, `html`, and plots
- MCP server registry endpoints for future external tool integration
- a LangGraph-backed action routing layer with a LiteLLM model gateway fallback path

## Project structure

- `frontend/`: Next.js app
- `backend/`: FastAPI API, SQLite storage, provider integrations
- `.env.example`: shared environment variable template

## Documentation

Detailed architecture docs, onboarding guides, and API reference live in the `docs/` folder:

- [`docs/architecture.md`](docs/architecture.md) — Full system architecture with Mermaid diagrams, data flow, ER diagrams, and module breakdowns
- [`docs/getting-started.md`](docs/getting-started.md) — Quick-start guide for new contributors
- [`docs/api-reference.md`](docs/api-reference.md) — Complete REST + SSE endpoint reference

## Prerequisites

- Node.js 20+ and npm
- Python 3.9+
- At least one model provider configured:
  - `OPENAI_API_KEY`, or
  - `ANTHROPIC_API_KEY`, or
  - `GEMINI_API_KEY`, or
  - a local Ollama server at `http://localhost:11434`

## Environment setup

Copy the example env file:

```bash
cp .env.example .env
```

Then fill in the provider keys you want to use.

Frontend uses an optional API URL override:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

If you do not set it, the frontend defaults to `http://localhost:8000`.

## Backend setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Start the API:

```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at [http://localhost:8000](http://localhost:8000).

## Frontend setup

```bash
cd frontend
npm install
npm run dev
```

The UI will be available at [http://localhost:3000](http://localhost:3000).

## How to start the app

Run both services in separate terminals.

Terminal 1:

```bash
cd /Users/charinpatel/workspace/projects/omni-mind/backend
source .venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Terminal 2:

```bash
cd /Users/charinpatel/workspace/projects/omni-mind/frontend
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Useful commands

Backend:

```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload
```

Frontend:

```bash
cd frontend
npm run dev
npm run build
npm run lint
```

## Notes

- Conversation data uses SQLite by default through `DATABASE_URL=sqlite+aiosqlite:///omni_mind.db`.
- The backend allows CORS from `http://localhost:3000`.
- Generated artifacts are served from `http://localhost:8000/artifacts/...`.
- If `litellm` is installed, standard chat execution uses a provider-agnostic gateway instead of only the custom provider classes.
- If `langgraph` is installed, artifact/research/chat routing runs through a graph runtime that is ready for richer agent workflows.
- Expansion notes and recommended OSS building blocks live in `docs/agent-expansion-roadmap.md`.
- The existing checked-in `backend/venv/` looks like a local environment and should not be relied on for a fresh setup. Prefer creating `backend/.venv/`.
