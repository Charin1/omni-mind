# OmniMind — Architecture Guide

> **Audience:** New contributors, reviewers, and future-you.
> **Last updated:** 2026-08-12

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [High-Level System Architecture](#2-high-level-system-architecture)
3. [Repository Layout](#3-repository-layout)
4. [Request Lifecycle — End to End](#4-request-lifecycle--end-to-end)
5. [Backend Deep Dive](#5-backend-deep-dive)
   - [5.1 API Layer](#51-api-layer)
   - [5.2 Agent & Routing Layer](#52-agent--routing-layer)
   - [5.3 LLM Provider System](#53-llm-provider-system)
   - [5.4 Context Window Management](#54-context-window-management)
   - [5.5 Memory Engine](#55-memory-engine)
   - [5.6 Tool System](#56-tool-system)
   - [5.7 MCP Integration](#57-mcp-integration)
   - [5.8 Research Pipeline](#58-research-pipeline)
   - [5.9 Artifact Generation](#59-artifact-generation)
   - [5.10 Data Layer](#510-data-layer)
   - [5.11 Runtime & Concurrency](#511-runtime--concurrency)
6. [Frontend Deep Dive](#6-frontend-deep-dive)
7. [Observability Stack](#7-observability-stack)
8. [Data Flow Diagrams](#8-data-flow-diagrams)
9. [Database Schema (ER Diagram)](#9-database-schema-er-diagram)
10. [Environment Variables Reference](#10-environment-variables-reference)
11. [Extension Points](#11-extension-points)

---

## 1. Product Overview

**OmniMind** is a full-stack AI chat application that goes beyond simple prompt → response interactions. It provides:

| Capability | Description |
|---|---|
| **Multi-Provider LLM Chat** | Swap between OpenAI, Anthropic, Google, and local Ollama models in real time |
| **Conversation Persistence** | Per-user, per-conversation history stored in SQLite with cross-refresh survival |
| **Rolling Summaries** | Long conversations are auto-summarized to stay within context windows |
| **Semantic Memory** | User facts and preferences are extracted, vectorized (ChromaDB), and recalled in future sessions |
| **Artifact Generation** | Create downloadable `.docx`, `.xlsx`, `.html` files, and interactive Plotly charts from chat |
| **Deep Research** | Multi-step agentic web research with parallel fetching, knowledge extraction, and synthesis |
| **Computer Use** | Sandboxed shell execution, file I/O, and directory browsing for the AI agent |
| **MCP Integration** | Connect external tool servers via stdio, HTTP, or SSE transports (Model Context Protocol) |
| **Tool Approval** | Human-in-the-loop confirmation before the AI executes sensitive tools |
| **Projects** | Group conversations under a project with custom system instructions |
| **Observability** | Full OpenTelemetry pipeline → Grafana (metrics, traces, logs) |

---

## 2. High-Level System Architecture

```mermaid
graph TB
    subgraph User["🧑‍💻 User"]
        Browser["Browser"]
    end

    subgraph Frontend["Frontend — Next.js :3000"]
        UI["React UI<br/>page.tsx"]
        APIClient["API Client<br/>lib/api.ts"]
    end

    subgraph Backend["Backend — FastAPI :8000"]
        direction TB
        API["API Routers<br/>(chat, conversations,<br/>projects, memory,<br/>artifacts, mcp,<br/>tasks, settings,<br/>tool_approval)"]

        subgraph Core["Core Engine"]
            GraphRT["Graph Runtime<br/>(LangGraph)"]
            ActionRouter["Action Router"]
            SessionMgr["Chat Session Manager"]
            CtxMgr["Context Manager"]
        end

        subgraph Intelligence["Intelligence Layer"]
            Providers["Provider Registry<br/>(OpenAI, Anthropic,<br/>Google, Ollama)"]
            LiteLLM["LiteLLM Gateway"]
            MemEngine["Memory Engine"]
            VectorStore["Vector Store<br/>(ChromaDB)"]
        end

        subgraph Tools["Tool Layer"]
            WebSearch["Web Search"]
            Artifacts["Artifact Service"]
            ComputerUse["Computer Use<br/>(Sandboxed)"]
            MCPHub["MCP Client Hub"]
        end

        subgraph Research["Research Pipeline"]
            ResearchSvc["Research Service"]
            Orchestrator["Research Orchestrator"]
        end
    end

    subgraph Storage["Storage"]
        SQLite["SQLite<br/>omni_mind.db"]
        ChromaDB["ChromaDB<br/>chroma_db/"]
        ArtifactFiles["Generated Artifacts<br/>generated_artifacts/"]
    end

    subgraph Observability["Observability Stack"]
        OTelCol["OTel Collector"]
        Prometheus["Prometheus"]
        Tempo["Tempo"]
        Loki["Loki"]
        Grafana["Grafana :3001"]
    end

    subgraph External["External Services"]
        LLMAPIs["LLM APIs<br/>(OpenAI, Anthropic,<br/>Google, Ollama)"]
        SearchEngines["Search Engines<br/>(DuckDuckGo, Bing)"]
        MCPServers["MCP Servers<br/>(External Tools)"]
    end

    Browser --> UI
    UI --> APIClient
    APIClient -- "SSE / REST" --> API
    API --> Core
    Core --> Intelligence
    Core --> Tools
    Core --> Research
    Intelligence --> Providers
    Providers --> LLMAPIs
    Intelligence --> LiteLLM
    LiteLLM --> LLMAPIs
    MemEngine --> VectorStore
    VectorStore --> ChromaDB
    Tools --> SearchEngines
    Tools --> MCPServers
    Research --> WebSearch
    Research --> LiteLLM
    API --> SQLite
    Artifacts --> ArtifactFiles
    Backend -- "OTLP" --> OTelCol
    OTelCol --> Prometheus
    OTelCol --> Tempo
    OTelCol --> Loki
    Grafana --> Prometheus
    Grafana --> Tempo
    Grafana --> Loki
```

---

## 3. Repository Layout

```
omni-mind/
├── frontend/                    # Next.js app (React + TypeScript)
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx         # Main chat UI (single-page app)
│   │   │   ├── layout.tsx       # Root layout
│   │   │   └── globals.css      # Global styles
│   │   └── lib/
│   │       ├── api.ts           # Backend API client (SSE + REST)
│   │       └── models.json      # Static model definitions
│   ├── package.json
│   └── tsconfig.json
│
├── backend/                     # FastAPI backend (Python)
│   ├── main.py                  # App entrypoint, router registration
│   ├── requirements.txt
│   │
│   ├── api/                     # HTTP route handlers
│   │   ├── chat.py              # Main chat endpoint (SSE streaming)
│   │   ├── conversations.py     # CRUD for conversations
│   │   ├── projects.py          # CRUD for projects
│   │   ├── memory.py            # Memory retrieval endpoints
│   │   ├── artifacts.py         # Artifact listing/download
│   │   ├── mcp.py               # MCP server management
│   │   ├── tasks.py             # Research task tracking
│   │   ├── tool_approval.py     # Human-in-the-loop approval
│   │   └── settings.py          # Key-value settings store
│   │
│   ├── agents/                  # Agent orchestration
│   │   ├── action_router.py     # Intent classification (chat/artifact/research)
│   │   └── graph_runtime.py     # LangGraph state machine
│   │
│   ├── chat/                    # Chat session management
│   │   └── session_manager.py   # Conversation persistence & rolling summaries
│   │
│   ├── context/                 # Context window management
│   │   ├── manager.py           # Multi-layer context assembly
│   │   ├── summarizer.py        # LLM-powered conversation summarization
│   │   └── token_counter.py     # tiktoken-based token counting
│   │
│   ├── providers/               # LLM provider abstraction
│   │   ├── base.py              # Abstract base class + shared models
│   │   ├── registry.py          # Singleton provider registry
│   │   ├── openai_provider.py
│   │   ├── anthropic_provider.py
│   │   ├── google_provider.py
│   │   └── ollama_provider.py
│   │
│   ├── llm/                     # Provider-agnostic gateway
│   │   └── litellm_gateway.py   # LiteLLM wrapper for unified API
│   │
│   ├── memory/                  # Semantic memory system
│   │   ├── engine.py            # Fact extraction + storage orchestration
│   │   ├── extractor.py         # LLM-powered fact extraction
│   │   └── vector_store.py      # ChromaDB wrapper
│   │
│   ├── tools/                   # Built-in tool implementations
│   │   ├── web_search.py        # DuckDuckGo/Bing web search + URL scraping
│   │   ├── artifacts.py         # DOCX/XLSX/HTML/Plot generation
│   │   └── computer_use.py      # Sandboxed shell/file operations
│   │
│   ├── app_mcp/                 # Model Context Protocol client
│   │   ├── client.py            # MCPClientHub (stdio/HTTP/SSE transports)
│   │   ├── oauth.py             # OAuth flow for protected MCP servers
│   │   └── tool_converter.py    # MCP → OpenAI tool schema conversion
│   │
│   ├── research/                # Deep research pipeline
│   │   ├── service.py           # Task lifecycle (plan → execute → report)
│   │   └── orchestrator.py      # Agentic web research engine
│   │
│   ├── runtime/                 # Runtime guards
│   │   └── limits.py            # Semaphore-based concurrency limits
│   │
│   ├── db/                      # Database layer
│   │   ├── database.py          # SQLAlchemy async engine setup
│   │   ├── models.py            # All ORM models
│   │   └── migrations.py        # Schema compatibility checks
│   │
│   ├── observability/           # Telemetry instrumentation
│   │   ├── __init__.py
│   │   ├── telemetry.py         # OTel SDK initialization
│   │   └── metrics.py           # Custom metrics
│   │
│   └── tests/                   # Backend test suite
│
├── observability/               # Docker-based observability stack
│   ├── docker-compose.yml       # OTel Collector + Prometheus + Tempo + Loki + Grafana
│   ├── otel-collector-config.yaml
│   ├── prometheus.yml
│   ├── tempo.yaml
│   └── grafana/
│       ├── provisioning/        # Datasource auto-provisioning
│       └── dashboards/          # Pre-built Grafana dashboards
│
├── .env.example                 # Environment variable template
├── setup.sh                     # One-shot project setup script
├── start.sh                     # Start both frontend + backend
└── README.md
```

---

## 4. Request Lifecycle — End to End

This is what happens when a user sends a message:

```mermaid
sequenceDiagram
    actor User
    participant UI as Next.js Frontend
    participant API as FastAPI /api/chat
    participant SM as Session Manager
    participant GR as Graph Runtime
    participant AR as Action Router
    participant CM as Context Manager
    participant ME as Memory Engine
    participant LLM as LLM Provider / LiteLLM
    participant DB as SQLite
    participant VS as ChromaDB

    User->>UI: Types message & clicks Send
    UI->>API: POST /api/chat (SSE stream)
    API->>SM: ensure_conversation()
    SM->>DB: Upsert Conversation row
    API->>SM: append_message(user)
    SM->>DB: INSERT user Message

    API->>GR: preflight(message)
    GR->>AR: decide(message)
    AR-->>GR: ActionDecision{mode, artifact_kind}

    alt mode == "artifact"
        GR->>GR: generate artifact → return early
        GR-->>API: response_text (artifact URL)
    else mode == "research"
        GR->>GR: create_plan → execute_plan
        GR-->>API: response_text (research report)
    else mode == "chat"
        GR-->>API: {mode: "chat"}
    end

    Note over API: If mode != "chat", stream preflight response & return

    API->>ME: retrieve_relevant_memories(query)
    ME->>VS: semantic search
    VS-->>ME: top-K memories
    ME-->>API: memory strings

    API->>SM: build_context_messages()
    SM->>DB: SELECT messages + summary
    SM-->>API: history + conversation_summary

    API->>CM: assemble_context(system_prompt, messages, memories, summary)
    CM->>CM: Token counting + auto-compression
    CM-->>API: final context messages[]

    API->>LLM: chat(context, tools) — streaming
    loop SSE chunks
        LLM-->>API: StreamChunk
        API-->>UI: data: {content: "..."}
        UI-->>User: Render token by token
    end

    alt Tool call detected
        API->>API: Execute tool (web_search / computer_use / MCP)
        API->>LLM: Feed tool result back → continue streaming
    end

    API->>SM: append_message(assistant, full_response)
    SM->>DB: INSERT assistant Message

    API->>ME: process_new_message() (extract facts)
    ME->>VS: Store new memories

    API->>SM: maybe_refresh_summary()
    SM->>DB: Update ConversationSummary

    API-->>UI: data: [DONE]
```

---

## 5. Backend Deep Dive

### 5.1 API Layer

The backend registers **9 routers** in `main.py`:

| Router | Prefix | Purpose |
|---|---|---|
| `chat` | `/api/chat` | Main chat endpoint (SSE streaming), provider listing, model listing |
| `conversations` | `/api/conversations` | CRUD operations on conversation history |
| `projects` | `/api/projects` | Group conversations under projects with custom instructions |
| `memory` | `/api/memory` | Query user memories |
| `artifacts` | `/api/artifacts` | List and serve generated artifacts |
| `mcp` | `/api/mcp` | Register, connect, and manage MCP tool servers |
| `tasks` | `/api/tasks` | Track research task runs and steps |
| `tool_approval` | `/api/tool-approval` | Human-in-the-loop tool execution approval |
| `settings` | `/api/settings` | Key-value settings persistence |

All responses from the chat endpoint use **Server-Sent Events (SSE)** for real-time token streaming.

---

### 5.2 Agent & Routing Layer

```mermaid
graph LR
    UserMsg["User Message"] --> AR["Action Router"]
    AR -- "detect_kind()" --> ArtifactQ{"Artifact keywords?<br/>docx, xlsx, html, plot"}
    ArtifactQ -- Yes --> ArtMode["mode: artifact"]
    ArtifactQ -- No --> ResearchQ{"Research keywords?<br/>research, deep dive,<br/>investigate, analyze..."}
    ResearchQ -- Yes --> ResMode["mode: research"]
    ResearchQ -- No --> ChatMode["mode: chat"]

    ArtMode --> GR["Graph Runtime"]
    ResMode --> GR
    ChatMode --> GR

    GR --> Decision{"LangGraph<br/>available?"}
    Decision -- Yes --> StateGraph["LangGraph StateGraph<br/>(decide → route → execute)"]
    Decision -- No --> Fallback["Built-in fallback<br/>(sequential execution)"]
```

**Key files:**
- [`action_router.py`](file:///Users/charinpatel/workspace/projects/omni-mind/backend/agents/action_router.py) — Keyword-based intent classification
- [`graph_runtime.py`](file:///Users/charinpatel/workspace/projects/omni-mind/backend/agents/graph_runtime.py) — LangGraph state machine with graceful fallback

The **Graph Runtime** uses a `WorkflowState` TypedDict and builds a 4-node LangGraph:
1. `decide` — Classifies intent
2. `artifact` — Generates the requested file
3. `research` — Runs multi-step web research
4. `chat` — Falls through to the standard chat pipeline

---

### 5.3 LLM Provider System

```mermaid
classDiagram
    class BaseLLMProvider {
        <<abstract>>
        +chat(messages, config, tools)*
        +count_tokens(messages, model)*
        +get_context_limit(model)*
        +get_available_models()*
    }

    class OpenAIProvider {
        +chat()
        +count_tokens()
        +get_context_limit()
        +get_available_models()
    }

    class AnthropicProvider {
        +chat()
        +count_tokens()
        +get_context_limit()
        +get_available_models()
    }

    class GoogleProvider {
        +chat()
        +count_tokens()
        +get_context_limit()
        +get_available_models()
    }

    class OllamaProvider {
        +chat()
        +count_tokens()
        +get_context_limit()
        +get_available_models()
    }

    class ProviderRegistry {
        -_providers: Dict
        -_instances: Dict
        +register(name, class)
        +get_provider(name): BaseLLMProvider
        +list_providers(): Dict
    }

    class LiteLLMGateway {
        +available: bool
        +resolve_model(provider, model)
        +stream_chat(provider, messages, config)
        +chat(provider, messages, config)
    }

    BaseLLMProvider <|-- OpenAIProvider
    BaseLLMProvider <|-- AnthropicProvider
    BaseLLMProvider <|-- GoogleProvider
    BaseLLMProvider <|-- OllamaProvider
    ProviderRegistry --> BaseLLMProvider : manages
    LiteLLMGateway ..> BaseLLMProvider : alternative path
```

**Two execution paths:**
1. **Custom Providers** — Direct SDK integration (OpenAI, Anthropic, Google, Ollama) via the `ProviderRegistry`
2. **LiteLLM Gateway** — Provider-agnostic routing when `litellm` is installed. Used by the research pipeline and as a fallback chat path.

---

### 5.4 Context Window Management

The `ContextManager` assembles the final prompt through a multi-layer strategy:

```mermaid
graph TD
    subgraph ContextAssembly["Context Assembly Pipeline"]
        L1["Layer 1: System Prompt"]
        L2["Layer 2: Conversation Summary<br/>(if exists)"]
        L3["Layer 3: Relevant Memories<br/>(semantic search)"]
        L4["Layer 4: Chat History<br/>(recent messages)"]
    end

    L1 --> L2 --> L3 --> L4

    L4 --> TC{"Token Count > 80%<br/>of limit?"}
    TC -- No --> Send["Send to LLM"]
    TC -- Yes --> Compress["Auto-Compress"]

    Compress --> HasHistory{"> 4 messages?"}
    HasHistory -- Yes --> Summarize["Summarize old messages<br/>Keep last 4"]
    HasHistory -- No --> Truncate["Truncate oldest messages<br/>Keep at least 1"]
    Summarize --> Send
    Truncate --> Send
```

**Key details:**
- Context limit is resolved per-provider, per-model (up to 400K tokens max)
- 20% of the limit is reserved for the assistant's response
- Compression triggers at 80% usage
- Uses `tiktoken` for token counting (falls back to `cl100k_base` for unknown models)

---

### 5.5 Memory Engine

```mermaid
graph LR
    subgraph Ingestion["Memory Ingestion"]
        UserMsg["User Message"] --> FE["FactExtractor<br/>(LLM-powered)"]
        FE --> Facts["Structured Facts<br/>{fact, type, importance}"]
        Facts --> SQL["SQLite<br/>(Memory table)"]
        Facts --> Vec["ChromaDB<br/>(Vector embeddings)"]
    end

    subgraph Retrieval["Memory Retrieval"]
        Query["New user query"] --> Search["Semantic Search<br/>(cosine distance < 0.4)"]
        Search --> Vec
        Vec --> TopK["Top-K relevant memories"]
        TopK --> Context["Injected into<br/>context assembly"]
    end
```

**Memory types:** `preference`, `decision`, `fact`, `event`

The `FactExtractor` asks the LLM to identify significant information from user messages and returns structured JSON. Memories are dual-stored: SQL for management, ChromaDB for retrieval.

---

### 5.6 Tool System

OmniMind has three categories of tools available to the AI:

```mermaid
graph TB
    subgraph BuiltIn["Built-in Tools"]
        WS["🔍 Web Search<br/>(search_web, read_url)"]
        CU["💻 Computer Use<br/>(run_command, read_file,<br/>write_file, edit_file,<br/>list_directory)"]
    end

    subgraph MCPTools["MCP Tools"]
        MCP["🔌 External MCP Servers<br/>(dynamically discovered)"]
    end

    subgraph ArtifactTools["Artifact Tools"]
        AG["📄 Artifact Generation<br/>(docx, xlsx, html, plot)"]
    end

    BuiltIn --> ToolLoop["Tool Call Loop<br/>in chat.py"]
    MCPTools --> ToolLoop
    ToolLoop --> Approval{"Requires<br/>approval?"}
    Approval -- "Computer Use" --> HITL["Human-in-the-Loop<br/>Approval UI"]
    Approval -- "Other" --> Execute["Direct Execution"]
    HITL -- Approved --> Execute
    HITL -- Rejected --> Skip["Skip & Inform LLM"]
```

**Web Search** uses a 3-engine fallback strategy:
1. DuckDuckGo HTML
2. DuckDuckGo Lite
3. Bing HTML

**Computer Use** is sandboxed:
- All operations confined to `WORKSPACE_ROOT` (default: `~/omnimind-workspace`)
- Path traversal protection (`../../` blocked)
- Dangerous commands blocked (`sudo`, `rm -rf /`, `shutdown`, fork bombs, etc.)
- Output truncated at 50KB, file reads at 15KB

---

### 5.7 MCP Integration

```mermaid
graph LR
    subgraph MCPConfig["MCP Server Registration"]
        DB_MCP["DB: mcp_servers table"]
        ConfigJSON["config_json<br/>{command, args, url,<br/>env, headers, token}"]
    end

    subgraph Transports["Transport Layer"]
        STDIO["stdio<br/>(local subprocess)"]
        HTTP["streamable_http<br/>(remote HTTP)"]
        SSE["sse<br/>(legacy HTTP+SSE)"]
    end

    subgraph Hub["MCPClientHub"]
        Sessions["Active Sessions<br/>(Dict[name, ClientSession])"]
        ListTools["list_tools()"]
        CallTool["call_tool()"]
    end

    DB_MCP --> Hub
    Hub --> STDIO
    Hub --> HTTP
    Hub --> SSE
    HTTP --> Probe["Preflight Probe<br/>(401 → OAuth flow)"]
    Hub --> Sessions
    Sessions --> ListTools
    Sessions --> CallTool
```

The MCP client supports OAuth 2.0 authorization for protected servers (RFC 9728 discovery).

---

### 5.8 Research Pipeline

```mermaid
graph TD
    Query["User's Research Query"] --> SubQ["Generate 3-4<br/>Sub-Queries (LLM)"]
    SubQ --> ParSearch["Parallel Web Search<br/>(one per sub-query)"]
    ParSearch --> Dedup["Deduplicate URLs<br/>(max 2 per domain)"]
    Dedup --> Fetch["Parallel Fetch<br/>(up to 10 URLs)"]
    Fetch --> Chunk["Chunk Large Pages<br/>(6-32KB based on provider)"]
    Chunk --> Extract["Parallel Fact Extraction<br/>(LLM per chunk)"]
    Extract --> Synth["Final Synthesis<br/>(structured report with citations)"]
    Synth --> Report["Markdown Report"]

    style Query fill:#e1f5fe
    style Report fill:#c8e6c9
```

**Concurrency tuning by provider:**

| Provider | Max Concurrency | Chunk Size |
|---|---|---|
| Ollama / LMStudio | 2 | 6 KB |
| OpenAI / Anthropic / Google | 15 | 32 KB |
| Other | 5 | 12 KB |

Hard timeout: **2 minutes** for the entire extraction phase.

---

### 5.9 Artifact Generation

```mermaid
graph LR
    Detect["detect_kind(message)"] --> |"docx / xlsx / html / plot"| Gen["generate_artifact()"]
    Gen --> Temp["Temp Directory<br/>(isolated workspace)"]
    Temp --> Create{"Artifact Type"}
    Create --> DOCX["python-docx<br/>→ .docx"]
    Create --> XLSX["xlsxwriter<br/>→ .xlsx"]
    Create --> HTML["Template<br/>→ .html"]
    Create --> Plot["Plotly<br/>→ interactive .html"]
    DOCX --> Save["Save to<br/>generated_artifacts/<br/>{user_id}/{conv_id}/"]
    XLSX --> Save
    HTML --> Save
    Plot --> Save
    Save --> DB_Art["Record in<br/>Artifact table"]
    DB_Art --> URL["Serve via<br/>/artifacts/..."]
```

Artifacts are generated inside a `tempfile.TemporaryDirectory` for isolation, then moved to the permanent output directory.

---

### 5.10 Data Layer

All persistent data is stored in **SQLite** (async via `aiosqlite`), with **ChromaDB** for vector embeddings.

```mermaid
erDiagram
    Project ||--o{ Conversation : "has"
    Conversation ||--o{ Message : "contains"
    Conversation ||--o| ConversationSummary : "has"
    Conversation ||--o{ Artifact : "produces"
    Conversation ||--o{ TaskRun : "triggers"
    TaskRun ||--o{ TaskStep : "has"

    Project {
        string id PK
        string user_id
        string name
        text description
        text instructions
        datetime created_at
        datetime updated_at
    }

    Conversation {
        string id PK
        string user_id
        string project_id FK
        string title
        string provider
        string model
        datetime created_at
        datetime updated_at
    }

    Message {
        string id PK
        string conversation_id FK
        string role
        text content
        int token_count
        datetime created_at
    }

    Memory {
        string id PK
        string user_id
        string conversation_id
        string type
        text content
        json tags
        float importance
        string embedding_id
        datetime created_at
        datetime updated_at
    }

    Episode {
        string id PK
        string user_id
        string conversation_id
        text summary
        datetime created_at
    }

    ConversationSummary {
        string id PK
        string user_id
        string conversation_id UK
        text summary
        int summarized_message_count
        datetime updated_at
    }

    Artifact {
        string id PK
        string user_id
        string conversation_id FK
        string kind
        string name
        string path
        string mime_type
        string status
        json metadata_json
        datetime created_at
    }

    TaskRun {
        string id PK
        string user_id
        string conversation_id FK
        string kind
        string title
        string status
        text input_prompt
        text summary
        json metadata_json
        datetime created_at
        datetime updated_at
    }

    TaskStep {
        string id PK
        string task_id FK
        int position
        string title
        text description
        string status
        text output_text
        datetime created_at
        datetime updated_at
    }

    Setting {
        string key PK
        json value
    }

    MCPServer {
        string id PK
        string name UK
        string transport
        json config_json
        boolean is_active
    }
```

---

### 5.11 Runtime & Concurrency

The backend uses `asyncio.Semaphore` guards to prevent overload:

| Resource | Default Limit | Env Var |
|---|---|---|
| Chat requests | 40 | `CHAT_CONCURRENCY_LIMIT` |
| Artifact generation | 8 | `ARTIFACT_CONCURRENCY_LIMIT` |
| Computer use tools | 4 | `COMPUTER_USE_CONCURRENCY_LIMIT` |

---

## 6. Frontend Deep Dive

The frontend is a **Next.js** app with a single-page React UI.

```mermaid
graph TB
    subgraph FrontendArch["Frontend Architecture"]
        Page["page.tsx<br/>(~97KB monolith)"]
        APILib["lib/api.ts<br/>(API client)"]
        Models["lib/models.json<br/>(static model defs)"]
        Styles["globals.css"]
    end

    subgraph UIFeatures["UI Features"]
        Chat["Chat Interface<br/>(streaming responses)"]
        Sidebar["Conversation Sidebar<br/>(history, search)"]
        ProviderPicker["Provider & Model Selector"]
        ProjectMgr["Project Manager"]
        ToolApproval["Tool Approval Dialogs"]
        ArtifactPanel["Artifact Viewer"]
        MCPPanel["MCP Server Manager"]
        SettingsPanel["Settings Panel"]
        ThinkingUI["Thinking Indicator<br/>(for reasoning models)"]
        ResearchUI["Research Progress Bar"]
    end

    Page --> Chat
    Page --> Sidebar
    Page --> ProviderPicker
    Page --> ProjectMgr
    Page --> ToolApproval
    Page --> ArtifactPanel
    Page --> MCPPanel
    Page --> SettingsPanel
    Page --> ThinkingUI
    Page --> ResearchUI
    APILib --> Page
```

**Communication:**
- Chat uses **SSE (Server-Sent Events)** for streaming
- All other endpoints use standard REST
- SSE events include: `content`, `thinking_start/chunk/end`, `tool_approval_request`, `research_progress`, `tool_status`, `tool_sources`, `response_replace`, `[DONE]`

---

## 7. Observability Stack

```mermaid
graph LR
    Backend["FastAPI Backend<br/>(OTel SDK)"] -- "OTLP/HTTP :4318" --> Collector["OTel Collector"]
    Collector -- "remote_write" --> Prometheus["Prometheus :9090<br/>(Metrics)"]
    Collector -- "OTLP/gRPC" --> Tempo["Tempo :3200<br/>(Traces)"]
    Collector -- "loki/v1/push" --> Loki["Loki :3100<br/>(Logs)"]
    Prometheus --> Grafana["Grafana :3001"]
    Tempo --> Grafana
    Loki --> Grafana
```

**Quick start:**
```bash
docker compose -f observability/docker-compose.yml up -d
# Then open http://localhost:3001 (anonymous admin, no login)
```

**Custom metrics** (defined in `observability/metrics.py`) are exported via the OTel SDK and scraped by Prometheus.

---

## 8. Data Flow Diagrams

### 8.1 Tool Call Loop (Agentic Execution)

```mermaid
stateDiagram-v2
    [*] --> AssembleContext
    AssembleContext --> StreamLLM
    StreamLLM --> CheckToolCalls

    CheckToolCalls --> HasTools: Tool calls detected
    CheckToolCalls --> Done: No tool calls / finish_reason=stop

    HasTools --> NeedsApproval: Computer Use tool?
    HasTools --> Execute: Web Search / MCP tool

    NeedsApproval --> WaitApproval: Send approval request to UI
    WaitApproval --> Execute: User approved
    WaitApproval --> SkipTool: User rejected

    Execute --> AppendToolResult
    SkipTool --> AppendToolResult: "Tool rejected by user"
    AppendToolResult --> StreamLLM: Feed result back to LLM

    Done --> SaveResponse
    SaveResponse --> ExtractMemories
    ExtractMemories --> RefreshSummary
    RefreshSummary --> [*]
```

### 8.2 Memory Lifecycle

```mermaid
graph TD
    subgraph Write["Write Path"]
        UM["User sends message"] --> FE["FactExtractor<br/>(LLM call)"]
        FE --> |"JSON list of facts"| Dual["Dual-Write"]
        Dual --> SQL["SQLite Memory table"]
        Dual --> Chroma["ChromaDB<br/>(auto-embedding)"]
    end

    subgraph Read["Read Path"]
        NQ["New query arrives"] --> Sem["Semantic Search<br/>(ChromaDB)"]
        Sem --> Filter["Filter: distance < 0.4<br/>+ user_id match"]
        Filter --> Inject["Inject into context<br/>as system message"]
    end
```

---

## 9. Database Schema (ER Diagram)

See the full ER diagram in [Section 5.10](#510-data-layer).

**Quick reference for table purposes:**

| Table | Purpose |
|---|---|
| `projects` | Grouping conversations under a shared context |
| `conversations` | Chat sessions with provider/model metadata |
| `messages` | Individual chat messages (user, assistant, system, tool) |
| `memories` | Extracted user facts and preferences |
| `episodes` | Conversation episode summaries |
| `conversation_summaries` | Rolling conversation summaries for context compression |
| `artifacts` | Generated file metadata (docx, xlsx, html, plot) |
| `task_runs` | Research task lifecycle tracking |
| `task_steps` | Individual steps within a research task |
| `settings` | Key-value configuration store |
| `mcp_servers` | Registered MCP server configurations |

---

## 10. Environment Variables Reference

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | OpenAI provider authentication |
| `ANTHROPIC_API_KEY` | — | Anthropic provider authentication |
| `GEMINI_API_KEY` | — | Google Gemini provider authentication |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server address |
| `OLLAMA_NUM_CTX` | `16384` | Ollama context window size |
| `DATABASE_URL` | `sqlite+aiosqlite:///omni_mind.db` | Database connection string |
| `DEFAULT_CONTEXT_LIMIT` | `128000` | Fallback token limit |
| `COMPUTER_USE_WORKSPACE` | `~/omnimind-workspace` | Sandboxed workspace root |
| `CHAT_CONCURRENCY_LIMIT` | `40` | Max concurrent chat requests |
| `ARTIFACT_CONCURRENCY_LIMIT` | `8` | Max concurrent artifact generations |
| `COMPUTER_USE_CONCURRENCY_LIMIT` | `4` | Max concurrent computer-use tool executions |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8000` | Frontend → Backend URL |

---

## 11. Extension Points

OmniMind is designed for expansion. Here are the key hooks:

| What to Add | Where to Hook |
|---|---|
| **New LLM provider** | Create a class extending `BaseLLMProvider` in `providers/`, register it in `providers/__init__.py` |
| **New built-in tool** | Add tool schemas + implementation in `tools/`, wire into the tool loop in `api/chat.py` |
| **New artifact type** | Add a `_create_<type>` method in `tools/artifacts.py`, update `detect_kind()` |
| **New API endpoint** | Create a new router in `api/`, register it in `main.py` |
| **External tools** | Register an MCP server via the UI or API — tools are auto-discovered |
| **Custom metrics** | Add counters/histograms in `observability/metrics.py` |
| **New research strategy** | Extend `ResearchOrchestrator` in `research/orchestrator.py` |
| **New database model** | Add an ORM class in `db/models.py` — auto-created on startup |

---

> **Tip for new contributors:** Start by reading [`api/chat.py`](file:///Users/charinpatel/workspace/projects/omni-mind/backend/api/chat.py) — it's the central hub that ties together all subsystems. Follow the imports to understand how each module connects.
