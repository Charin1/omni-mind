from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional, Any
import os
import json
import re
import logging
import asyncio
import time
from sqlalchemy.ext.asyncio import AsyncSession

from agents.graph_runtime import GraphRuntime
import providers  # noqa: F401
from agents.action_router import ActionRouter
from chat.session_manager import ChatSessionManager
from llm.litellm_gateway import LiteLLMGateway
from providers.registry import registry
from providers.base import Message, ModelConfig
from context.manager import ContextManager
from context.token_counter import count_tokens
from memory.engine import MemoryEngine
from memory.vector_store import VectorStore
from db.database import get_db
from db.models import Project
from app_mcp.client import mcp_hub
from app_mcp.tool_converter import ToolConverter
from research.service import ResearchService
from runtime.limits import chat_semaphore, computer_use_semaphore
from tools.artifacts import ArtifactService
from tools.web_search import web_search_tools
from research.orchestrator import orchestrator as research_orchestrator
from tools.computer_use import computer_use_tools, TOOL_SCHEMAS as COMPUTER_USE_SCHEMAS
from api.tool_approval import create_approval, wait_for_approval
from api.settings import get_setting_value
from observability import metrics as obs

logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatSettings(BaseModel):
    system_prompt: Optional[str] = None
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = None
    enabled_tools: List[str] = []


class ChatRequest(BaseModel):
    conversation_id: str
    user_id: Optional[str] = "local-user"
    message: str
    provider: str
    model: str
    history: List[Message] = []
    settings: Optional[ChatSettings] = None
    project_id: Optional[str] = None


context_manager = ContextManager()
vector_store = VectorStore()
llm_gateway = LiteLLMGateway()


def _extract_json_block(text: str) -> Optional[str]:
    raw = (text or "").strip()
    if not raw:
        return None

    # Try parsing the whole thing first
    try:
        json.loads(raw)
        return raw
    except Exception:
        pass

    # Clean markdown fences
    cleaned = re.sub(r'^```(?:json|markdown|md)?\s*', '', raw)
    cleaned = re.sub(r'\s*```$', '', cleaned).strip()
    try:
        json.loads(cleaned)
        return cleaned
    except Exception:
        pass

    # Find first { and last }
    first_brace = raw.find('{')
    last_brace = raw.rfind('}')
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        candidate = raw[first_brace:last_brace + 1]
        try:
            json.loads(candidate)
            return candidate
        except Exception:
            pass

    # Find first [ and last ]
    first_bracket = raw.find('[')
    last_bracket = raw.rfind(']')
    if first_bracket != -1 and last_bracket != -1 and last_bracket > first_bracket:
        candidate = raw[first_bracket:last_bracket + 1]
        try:
            json.loads(candidate)
            return candidate
        except Exception:
            pass

    return None


def _clean_json_wrapped_response(content: str) -> Optional[str]:
    json_block = _extract_json_block(content)
    if not json_block:
        return None

    try:
        parsed = json.loads(json_block)
    except Exception:
        return None

    if not isinstance(parsed, dict):
        return None

    # If it is a tool call, do not extract it as a final answer
    if "name" in parsed and "arguments" in parsed:
        return None

    for key in ("answer", "final", "response", "content", "result"):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    readable_parts = []
    for key in ("summary", "analysis", "plan", "thought", "reasoning"):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            readable_parts.append(value.strip())

def _extract_last_tool_summary(messages: list) -> Optional[str]:
    for msg in reversed(messages):
        content = getattr(msg, "content", "") or ""
        if getattr(msg, "role", None) in ("user", "tool") and "[System: Tool" in content:
            if "search_web" in content or "title" in content or "snippet" in content:
                return f"**Search Results Summary**:\n\n{content[:800]}..."
    return None


def _is_local_model(provider: str) -> bool:
    return provider.lower() in {"ollama", "lmstudio", "local"}


def _default_output_budget(provider: str, model: str) -> int:
    model_lower = (model or "").lower()
    if _is_local_model(provider):
        if any(marker in model_lower for marker in ("1b", "2b", "3b", "4b")):
            return 2048
        return 3072
    return 4096


def _starts_with_json_reasoning(content: str) -> bool:
    raw = (content or "").lstrip()
    return raw.startswith('{"thought"') or raw.startswith('{"analysis"') or raw.startswith('{"plan"')


# Phrases that signal the model narrated its plan / restated the tool results
# ("meta-reasoning") instead of actually answering. Common with small local
# models after a tool call — they describe what they *could* say and then stop.
_META_REASONING_MARKERS = (
    "the user wants",
    "the user is asking",
    "the user asked",
    "the user's question",
    "the user's query",
    "based on the search results",
    "the search results provide",
    "the search results show",
    "the search results indicate",
    "the search results contain",
    "i can find information",
    "i will now",
    "i should now",
    "let me synthesize",
    "let me now",
    "here is my plan",
)


def _looks_like_meta_reasoning(content: str) -> bool:
    """True if the text reads like the model talking about the task/results
    rather than answering the user. Only the opening is inspected so a genuine
    answer that happens to mention these phrases later isn't misclassified."""
    raw = (content or "").strip().lower()
    if not raw:
        return False
    head = raw[:160]
    return any(marker in head for marker in _META_REASONING_MARKERS)


def _extract_tool_sources(tool_name: str, tool_result_text: str) -> list[dict[str, str]]:
    if tool_name not in {"search_web", "deep_research"}:
        return []

    sources: list[dict[str, str]] = []
    try:
        parsed = json.loads(tool_result_text)
        if isinstance(parsed, list):
            for item in parsed:
                if not isinstance(item, dict):
                    continue
                href = item.get("href") or item.get("url")
                title = item.get("title") or href
                if isinstance(href, str) and href.startswith(("http://", "https://")):
                    sources.append({"title": str(title or href), "url": href})
    except Exception:
        for url in re.findall(r'https?://[^\s\]\)\}"<>]+', tool_result_text or ""):
            sources.append({"title": url, "url": url.rstrip(".,")})

    seen = set()
    deduped = []
    for source in sources:
        if source["url"] in seen:
            continue
        seen.add(source["url"])
        deduped.append(source)
    return deduped[:8]

@router.post("")
async def chat(request: ChatRequest, db: AsyncSession = Depends(get_db)):
    logger.info(f"Incoming chat request for provider '{request.provider}', model '{request.model}' (Conv: {request.conversation_id})")
    provider = registry.get_provider(request.provider)
    if not provider:
        logger.error(f"Provider {request.provider} not found")
        raise HTTPException(status_code=400, detail=f"Provider {request.provider} not found")

    user_id = request.user_id or "local-user"
    session_manager = ChatSessionManager(db)
    memory_engine = MemoryEngine(
        db,
        vector_store,
        provider_name=request.provider,
        model=request.model,
    )
    artifact_service = ArtifactService(db)
    research_service = ResearchService(db)
    graph_runtime = GraphRuntime(
        action_router=ActionRouter(artifact_service),
        artifact_service=artifact_service,
        research_service=research_service,
    )

    conversation = await session_manager.ensure_conversation(
        conversation_id=request.conversation_id,
        user_id=user_id,
        provider=request.provider,
        model=request.model,
        title=request.message[:60],
        project_id=request.project_id,
    )

    persisted_messages, stored_summary = await session_manager.build_context_messages(
        request.conversation_id
    )
    history_messages = persisted_messages or request.history

    # Retrieve tools conditionally based on enabled_tools selection
    llm_tools = []
    enabled_tool_names = request.settings.enabled_tools if request.settings else []
        
    mcp_tools = await mcp_hub.list_tools()
    filtered_mcp_tools = [t for t in mcp_tools if t.get('server') in enabled_tool_names] if mcp_tools else []
    
    if filtered_mcp_tools:
        # We always convert to standard OpenAI format, LiteLLM handles the REST mapping
        llm_tools = ToolConverter.to_openai(filtered_mcp_tools)
    
    if "web_search" in enabled_tool_names:
        # Inject ONLY search_web (index 0)
        llm_tools.append(web_search_tools.TOOL_SCHEMAS[0])
        
    if "deep_research" in enabled_tool_names:
        llm_tools.append({
            "type": "function",
            "function": {
                "name": "deep_research",
                "description": "Perform an autonomous deep research task. This tool analyzes the query, performs multiple searches, scrapes relevant pages, and synthesizes a comprehensive report. Use this for complex questions requiring thorough investigation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The complex research topic or question."
                        }
                    },
                    "required": ["query"]
                }
            }
        })

    if "computer_use" in enabled_tool_names:
        llm_tools.extend(COMPUTER_USE_SCHEMAS)

    # Computer-use tool names for routing
    COMPUTER_USE_TOOL_NAMES = {"run_command", "read_file", "write_file", "edit_file", "list_directory"}

    # 2. Retrieve relevant memories
    memories = await memory_engine.retrieve_relevant_memories(user_id, request.message)
    obs.record_memory_retrieval(len(memories) if memories else 0)
    
    local_model = _is_local_model(request.provider)

    # 3. Assemble context
    if local_model and "computer_use" not in enabled_tool_names:
        tool_instruction = (
            "If you need web search, output exactly one JSON tool call and nothing else: "
            '{"name":"search_web","arguments":{"query":"your search query"}}. '
            "After tool results are provided, answer the user directly in markdown text."
            if "web_search" in enabled_tool_names
            else "Answer the user directly in markdown text."
        )
        default_prompt = (
            "You are OmniMind, a concise AI assistant running on a local model. "
            "Do not reveal chain-of-thought. Do not output hidden reasoning. "
            "Never write JSON keys like thought, analysis, plan, or action unless you are making the exact tool call format. "
            "Final answers must be normal markdown/plain text only.\n\n"
            f"{tool_instruction}"
        )
    elif "computer_use" in enabled_tool_names:
        default_prompt = (
            "You are OmniMind, an autonomous coding and system agent. "
            "PLANNING: Always begin your response with a <think> block. Analyze the request, identify which files need to be read or modified, and plan your sequence of tool calls.\n\n"
            "IMPORTANT: Your final response to the user must be PLAIN TEXT. DO NOT wrap your final answer in JSON.\n\n"
            "Tools: run_command, read_file, write_file, edit_file, list_directory. "
            "Reason through every step in your <think> block before acting."
        )
    elif "deep_research" in enabled_tool_names:
        default_prompt = (
            "You are OmniMind, an autonomous Deep Research agent. "
            "PLANNING: Always begin your response with a <think> block.\n\n"
            "## TOOL USAGE GUARDRAILS:\n"
            "1. **NO SEARCH FOR GREETINGS:** Do NOT use search_web or deep_research for simple greetings (e.g., 'hi', 'hello'), pleasantries, or general conversation.\n"
            "2. **DEEP RESEARCH LIMIT:** If you have already called 'deep_research' once in this turn, DO NOT call it again. Synthesize the existing findings.\n"
            "3. **LOOP PREVENTION:** If a tool returns 'No results', do NOT repeat the same tool call with a slightly different query. Explain the limitation to the user.\n\n"
            "IMPORTANT: Your final response must be PLAIN TEXT. DO NOT wrap your final answer in JSON."
        )
    else:
        default_prompt = (
            "You are OmniMind, a powerful AI assistant. "
            "PLANNING: Always begin your response with a <think> block.\n\n"
            "## TOOL USAGE GUARDRAILS:\n"
            "1. **NO SEARCH FOR GREETINGS:** Do NOT use tools for simple greetings (e.g., 'hi', 'hello'), pleasantries, or general conversation.\n"
            "2. **LOOP PREVENTION:** Do not repeat tool calls that have already failed or returned no data.\n\n"
            "IMPORTANT: Your final response must be PLAIN TEXT. DO NOT wrap your final answer in JSON."
        )

    project_instructions = None
    if conversation.project_id:
        project = await db.get(Project, conversation.project_id)
        if project and project.instructions:
            project_instructions = project.instructions

    global_instructions = await get_setting_value(db, "system_instructions")

    if request.settings and request.settings.system_prompt:
        system_prompt = request.settings.system_prompt
    else:
        # Layer custom instructions ahead of the default prompt so the
        # default's tool guardrails stay intact: global (all chats) first,
        # then project-specific, then the built-in prompt.
        parts = []
        if global_instructions and str(global_instructions).strip():
            parts.append(f"## User instructions (apply to all chats)\n{str(global_instructions).strip()}")
        if project_instructions:
            parts.append(f"## Project instructions\n{project_instructions}")
        parts.append(default_prompt)
        system_prompt = "\n\n".join(parts)
    
    context = await context_manager.assemble_context(
        system_prompt=system_prompt,
        messages=history_messages,
        memories=memories,
        conversation_summary=stored_summary,
        provider=request.provider,
        model=request.model
    )
    
    user_message = Message(role="user", content=request.message)
    full_messages = context + [user_message]

    config = ModelConfig(
        model=request.model,
        temperature=request.settings.temperature if request.settings else 0.7,
        max_tokens=(
            request.settings.max_tokens
            if request.settings and request.settings.max_tokens
            else _default_output_budget(request.provider, request.model)
        ),
    )

    async def event_generator():
        try:
            input_tokens = count_tokens([user_message], request.model)
            obs.record_chat_tokens(request.provider, request.model, "input", input_tokens)
            await session_manager.append_message(
                request.conversation_id,
                "user",
                request.message,
                token_count_value=input_tokens,
            )

            if "deep_research" in enabled_tool_names:
                decision = graph_runtime.action_router.decide(request.message)
                if decision.mode == "research":
                    total_assistant_response = "\n\n> 🔍 *Starting Deep Research...*\n\n"
                    yield f"data: {json.dumps({'content': total_assistant_response, 'role': 'assistant'})}\n\n"

                    progress_queue = asyncio.Queue()

                    async def _on_direct_research_progress(msg: str, percent: int):
                        await progress_queue.put({"message": msg, "percentage": percent})

                    research_task = asyncio.create_task(research_orchestrator.execute_research(
                        query=request.message,
                        provider=request.provider,
                        model=request.model,
                        on_progress=_on_direct_research_progress
                    ))

                    while True:
                        if research_task.done() and progress_queue.empty():
                            break

                        try:
                            progress = await asyncio.wait_for(progress_queue.get(), timeout=0.2)
                            yield f"data: {json.dumps({'type': 'research_progress', **progress})}\n\n"
                        except asyncio.TimeoutError:
                            if research_task.done():
                                break
                            continue

                    report = await research_task
                    total_assistant_response += report
                    yield f"data: {json.dumps({'content': report, 'role': 'assistant'})}\n\n"

                    await session_manager.append_message(
                        request.conversation_id,
                        "assistant",
                        total_assistant_response,
                        token_count_value=count_tokens(
                            [Message(role="assistant", content=total_assistant_response)],
                            request.model,
                        ),
                    )
                    await memory_engine.process_new_message(
                        user_id=user_id,
                        conversation_id=request.conversation_id,
                        role="user",
                        content=request.message,
                    )
                    summary = await session_manager.maybe_refresh_summary(
                        conversation_id=request.conversation_id,
                        user_id=user_id,
                        provider=request.provider,
                        model=request.model,
                    )
                    if summary:
                        await memory_engine.store_episode(
                            user_id=user_id,
                            conversation_id=request.conversation_id,
                            summary=summary,
                        )
                    yield "data: [DONE]\n\n"
                    return

            workflow_result = await graph_runtime.preflight(
                user_id=user_id,
                conversation_id=request.conversation_id,
                message=request.message,
                provider=request.provider,
                model=request.model,
            )

            if workflow_result.get("mode") in {"artifact", "research"}:
                action_message = workflow_result.get("response_text", "")
                await session_manager.append_message(
                    request.conversation_id,
                    "assistant",
                    action_message,
                    token_count_value=count_tokens(
                        [Message(role="assistant", content=action_message)],
                        request.model,
                    ),
                )
                await memory_engine.process_new_message(
                    user_id=user_id,
                    conversation_id=request.conversation_id,
                    role="user",
                    content=request.message,
                )
                await session_manager.maybe_refresh_summary(
                    conversation_id=request.conversation_id,
                    user_id=user_id,
                    provider=request.provider,
                    model=request.model,
                )
                yield f"data: {json.dumps({'content': action_message, 'role': 'assistant'})}\n\n"
                yield "data: [DONE]\n\n"
                return

            # --- Agentic Execution Loop ---
            total_assistant_response = ""
            if "computer_use" in enabled_tool_names:
                max_iterations = 15
            elif "deep_research" in enabled_tool_names:
                max_iterations = 8
            else:
                max_iterations = 3
            iterations = 0

            # Post-tool synthesis guard: small local models often answer a tool
            # turn with meta-reasoning instead of a real answer. We force exactly
            # one stricter retry before giving up.
            executed_tool_this_run = False
            synthesis_retry_used = False

            while iterations < max_iterations:
                iterations += 1
                assistant_response = ""
                raw_model_output = ""
                gathered_tool_calls: dict[int, dict] = {}
                iter_response_start = len(total_assistant_response)  # for rollback if text tool call detected
                suppress_json_reasoning = False

                # Thinking block state machine (for <think>...</think> tokens).
                # Reset per-iteration: each LLM completion is an independent
                # response with its own <think> block. Leaking this state across
                # iterations causes a synthesis turn after a tool call to be
                # treated as thinking and never shown to the user (stuck spinner).
                _think_in_block = False
                _think_buf = ""  # rolling buffer for tag boundary detection
                current_tools = None if (executed_tool_this_run and local_model) else (llm_tools if llm_tools else None)

                async with chat_semaphore:
                    if llm_gateway.available:
                        try:
                            async for chunk in llm_gateway.stream_chat(
                                provider=request.provider,
                                messages=full_messages,
                                config=config,
                                tools=current_tools,
                            ):
                                # Tool calls stream in fragments on OpenAI/Anthropic-compatible
                                # backends. Accumulate them as they arrive; the final chunk may
                                # only contain finish_reason="tool_calls".
                                if chunk.tool_calls:
                                    for tc in chunk.tool_calls:
                                        idx = getattr(tc, "index", 0)
                                        function = getattr(tc, "function", None)
                                        tc_id = getattr(tc, "id", None)
                                        name = getattr(function, "name", None) if function else None
                                        arguments = getattr(function, "arguments", None) if function else None
                                        if idx not in gathered_tool_calls:
                                            gathered_tool_calls[idx] = {
                                                "id": tc_id or f"call_{iterations}_{idx}", 
                                                "name": name or "", 
                                                "arguments": arguments or ""
                                            }
                                        else:
                                            if tc_id:
                                                gathered_tool_calls[idx]["id"] = tc_id
                                            if name:
                                                gathered_tool_calls[idx]["name"] = name
                                            if arguments:
                                                gathered_tool_calls[idx]["arguments"] += arguments

                                if chunk.content:
                                    _think_buf += chunk.content
                                # Process buffer: separate <think> blocks from regular content
                                while True:
                                    if not _think_in_block:
                                        tag_start = _think_buf.find("<think>")
                                        if tag_start == -1:
                                            # If we are at the very beginning of the response, check if the start matches JSON reasoning.
                                            # We buffer up to 12 characters to ensure we can identify the JSON keys fully.
                                            if not assistant_response and len(_think_buf.lstrip()) < 12:
                                                is_prefix = False
                                                buf_lstripped = _think_buf.lstrip()
                                                for prefix in ('{"thought"', '{"analysis"', '{"plan"'):
                                                    if prefix.startswith(buf_lstripped):
                                                        is_prefix = True
                                                        break
                                                if is_prefix:
                                                    break # Keep buffering to see if it is JSON reasoning

                                            if not assistant_response and _starts_with_json_reasoning(_think_buf):
                                                suppress_json_reasoning = True
                                                # Keep buffering hidden reasoning so we can recover an
                                                # "answer" field if the model eventually emits one.
                                                if len(_think_buf) > 20000:
                                                    _think_buf = _think_buf[-12000:]
                                                break
                                            # No tag found; emit safe portion (keep last 7 chars buffered)
                                            if len(_think_buf) > 7:
                                                safe = _think_buf[:-7]
                                                _think_buf = _think_buf[-7:]
                                                assistant_response += safe
                                                total_assistant_response += safe
                                                yield f"data: {json.dumps({'content': safe, 'role': 'assistant'})}\n\n"
                                            break
                                        else:
                                            # Tag found: emit everything before <think> as content
                                            if tag_start > 0:
                                                pre_tag = _think_buf[:tag_start]
                                                assistant_response += pre_tag
                                                total_assistant_response += pre_tag
                                                yield f"data: {json.dumps({'content': pre_tag, 'role': 'assistant'})}\n\n"
                                            _think_in_block = True
                                            _think_buf = _think_buf[tag_start + 7:]
                                            yield f"data: {json.dumps({'type': 'thinking_start'})}\n\n"
                                    else:
                                        tag_end = _think_buf.find("</think>")
                                        if tag_end == -1:
                                            # Still inside <think> block; emit safe content
                                            if len(_think_buf) > 8:
                                                safe = _think_buf[:-8]
                                                _think_buf = _think_buf[-8:]
                                                yield f"data: {json.dumps({'type': 'thinking_chunk', 'content': safe})}\n\n"
                                            break
                                        else:
                                            # Closing tag found: emit remainder of think content
                                            pre_end = _think_buf[:tag_end]
                                            if pre_end:
                                                yield f"data: {json.dumps({'type': 'thinking_chunk', 'content': pre_end})}\n\n"
                                            yield f"data: {json.dumps({'type': 'thinking_end'})}\n\n"
                                            _think_in_block = False
                                            _think_buf = _think_buf[tag_end + 8:]

                        except Exception as e:
                            logger.error(f"LLM Stream Error: {e}", exc_info=True)
                            yield f"data: {json.dumps({'error': f'LLM Stream Error: {str(e)}'})}\n\n"
                            break

                        # Capture full raw response for text-based tool call detection
                        raw_model_output = assistant_response + _think_buf

                        # Flush any remaining buffer after the stream ends
                        if _think_in_block:
                            # Stream ended before the model closed </think> (e.g. it
                            # stopped to emit a tool call). Flush whatever is buffered
                            # and always close the block so the frontend thinking
                            # indicator doesn't stay open forever.
                            if _think_buf:
                                yield f"data: {json.dumps({'type': 'thinking_chunk', 'content': _think_buf})}\n\n"
                            yield f"data: {json.dumps({'type': 'thinking_end'})}\n\n"
                            _think_in_block = False
                            _think_buf = ""
                        elif _think_buf:
                            if suppress_json_reasoning and _starts_with_json_reasoning(_think_buf):
                                cleaned_reasoning_response = _clean_json_wrapped_response(_think_buf)
                                if cleaned_reasoning_response:
                                    assistant_response += cleaned_reasoning_response
                                    total_assistant_response += cleaned_reasoning_response
                                    yield f"data: {json.dumps({'type': 'response_replace', 'content': cleaned_reasoning_response})}\n\n"
                            else:
                                assistant_response += _think_buf
                                total_assistant_response += _think_buf
                                yield f"data: {json.dumps({'content': _think_buf, 'role': 'assistant'})}\n\n"
                            _think_buf = ""

                # --- Text-based tool call detection (Ollama / models without native function calling) ---
                # Some models output {"name": ..., "arguments": ...} as plain text instead of delta tool_calls.
                if not gathered_tool_calls and raw_model_output.strip() and not (executed_tool_this_run and local_model):
                    try:
                        raw_call = raw_model_output.strip()
                        # Extract the JSON substring if it's wrapped in text/fences
                        json_block = _extract_json_block(raw_call)
                        if json_block:
                            parsed = json.loads(json_block)
                            
                            # Handle models that wrap calls in a {"tool_calls": [...]} object
                            if isinstance(parsed, dict) and "tool_calls" in parsed and isinstance(parsed["tool_calls"], list):
                                candidates = parsed["tool_calls"]
                            else:
                                # Accept single call {name, arguments} or list of calls
                                candidates = [parsed] if isinstance(parsed, dict) else (parsed if isinstance(parsed, list) else [])
                                
                            for i, cand in enumerate(candidates):
                                if isinstance(cand, dict) and "name" in cand and "arguments" in cand:
                                    tool_name = cand["name"]
                                    # Explicitly skip "answer" if it's formatted as a tool call
                                    if tool_name == "answer":
                                        continue
                                        
                                    args = cand["arguments"]
                                    gathered_tool_calls[i] = {
                                        "id": f"txt_{iterations}_{i}",
                                        "name": tool_name,
                                        "arguments": json.dumps(args) if isinstance(args, dict) else str(args),
                                    }
                            if gathered_tool_calls:
                                # Rollback: remove the raw JSON blob from the visible assistant response
                                total_assistant_response = total_assistant_response[:iter_response_start]
                                assistant_response = ""
                                # Notify frontend the text was a tool call
                                yield f"data: {json.dumps({'type': 'tool_call_detected', 'count': len(gathered_tool_calls)})}\n\n"
                    except (json.JSONDecodeError, TypeError, ValueError):
                        pass

                if gathered_tool_calls:
                    # Construct standardized array for context window
                    tool_calls_payload = [
                        {
                            "id": vc["id"], 
                            "type": "function", 
                            "function": {"name": vc["name"], "arguments": vc["arguments"]}
                        } for vc in gathered_tool_calls.values()
                    ]
                    logger.info(f"Detected {len(gathered_tool_calls)} tool call(s): {[vc['name'] for vc in gathered_tool_calls.values()]}")
                    
                    # Append the model's call instruction so the history is accurate
                    is_text_tool = list(gathered_tool_calls.values())[0]["id"].startswith("txt_")
                    if is_text_tool:
                        # For text-based tool models, do NOT append the raw JSON tool call back into the history.
                        # Doing so causes smaller models to get "format lock-in" and only output JSON forever.
                        pass
                    else:
                        full_messages.append(Message(role="assistant", content=assistant_response or None, tool_calls=tool_calls_payload))
                    
                    for idx, call in gathered_tool_calls.items():
                        tool_name = call["name"]
                        try:
                            tool_args = json.loads(call["arguments"] or "{}")
                        except:
                            tool_args = {}

                        # ---- Computer Use tools: requires user approval ----
                        if tool_name in COMPUTER_USE_TOOL_NAMES:
                            icon = computer_use_tools.get_tool_icon(tool_name)
                            label = computer_use_tools.get_tool_description(tool_name)

                            # Build human-readable summary & detail for the approval card
                            if tool_name == "run_command":
                                summary = f"Run command: {tool_args.get('command', '?')[:100]}"
                                detail = tool_args.get("command", "")
                            elif tool_name == "read_file":
                                summary = f"Read file: {tool_args.get('path', '?')}"
                                detail = json.dumps(tool_args, indent=2)
                            elif tool_name == "write_file":
                                summary = f"Write file: {tool_args.get('path', '?')}"
                                detail = tool_args.get("content", "")
                            elif tool_name == "edit_file":
                                summary = f"Edit file: {tool_args.get('path', '?')}"
                                detail = f"--- Find ---\n{tool_args.get('target', '')}\n\n--- Replace with ---\n{tool_args.get('replacement', '')}"
                            elif tool_name == "list_directory":
                                summary = f"List directory: {tool_args.get('path', '.')}"
                                detail = json.dumps(tool_args, indent=2)
                            else:
                                summary = tool_name
                                detail = json.dumps(tool_args, indent=2)

                            # Create approval request
                            approval_req = create_approval(
                                tool_name=tool_name,
                                tool_args=tool_args,
                                display_summary=summary,
                                display_detail=detail,
                            )

                            # Stream approval request to frontend
                            approval_event = {
                                "type": "tool_approval_request",
                                "approval_id": approval_req.approval_id,
                                "tool_name": tool_name,
                                "tool_label": label,
                                "tool_icon": icon,
                                "summary": summary,
                                "detail": detail,
                                "tool_args": tool_args,
                            }
                            yield f"data: {json.dumps(approval_event)}\n\n"

                            status_msg = f"\n\n> {icon} *Waiting for approval: {label}*\n\n"
                            total_assistant_response += status_msg
                            yield f"data: {json.dumps({'content': status_msg, 'role': 'assistant'})}\n\n"

                            # Wait for user decision
                            approved = await wait_for_approval(approval_req, timeout=300.0)

                            if approved:
                                exec_msg = f"\n> ✅ *Approved — executing {label}...*\n\n"
                                total_assistant_response += exec_msg
                                yield f"data: {json.dumps({'content': exec_msg, 'role': 'assistant'})}\n\n"
                                yield f"data: {json.dumps({'type': 'tool_approval_resolved', 'approval_id': approval_req.approval_id, 'approved': True})}\n\n"

                                try:
                                    async with computer_use_semaphore:
                                        handler = getattr(computer_use_tools, tool_name)
                                        tool_result_text = await handler(**tool_args)
                                except Exception as e:
                                    tool_result_text = f"Error executing {tool_name}: {str(e)}"
                            else:
                                reject_reason = getattr(approval_req, 'reject_reason', None) or 'User rejected'
                                reject_msg = f"\n> ❌ *Rejected: {reject_reason}*\n\n"
                                total_assistant_response += reject_msg
                                yield f"data: {json.dumps({'content': reject_msg, 'role': 'assistant'})}\n\n"
                                yield f"data: {json.dumps({'type': 'tool_approval_resolved', 'approval_id': approval_req.approval_id, 'approved': False})}\n\n"
                                tool_result_text = f"User rejected this tool call. Reason: {reject_reason}. Adjust your approach or ask the user for guidance."

                        # ---- Non-computer-use tools: run directly ----
                        else:
                            yield f"data: {json.dumps({'type': 'tool_status', 'tool_name': tool_name, 'status': 'running'})}\n\n"
                            
                            logger.info(f"Executing non-computer tool: {tool_name} with args: {tool_args}")
                            tool_started_at = time.monotonic()
                            try:
                                if tool_name == "search_web":
                                    tool_result_text = await web_search_tools.search_web(**tool_args)
                                elif tool_name == "read_url":
                                    tool_result_text = await web_search_tools.read_url(**tool_args)
                                elif tool_name == "deep_research":
                                    # Bridge orchestrator progress to the SSE stream
                                    async def _on_progress(msg: str, percent: int):
                                        # Note: We are yielding to the outer event_generator's consumer
                                        pass 

                                    # To stream progress while awaiting the result, we use a Queue
                                    progress_queue = asyncio.Queue()
                                    async def _on_research_progress(msg: str, percent: int):
                                        await progress_queue.put({"message": msg, "percentage": percent})

                                    # Run research as a task so we can monitor the queue
                                    research_task = asyncio.create_task(research_orchestrator.execute_research(
                                        **tool_args,
                                        provider=request.provider,
                                        model=request.model,
                                        on_progress=_on_research_progress
                                    ))

                                    while True:
                                        # Exit only if task is done and no more messages are in queue
                                        if research_task.done() and progress_queue.empty():
                                            break
                                            
                                        try:
                                            # Wait for a progress update
                                            progress = await asyncio.wait_for(progress_queue.get(), timeout=0.2)
                                            logger.info(f"Streaming research progress: {progress['message']} ({progress['percentage']}%)")
                                            yield f"data: {json.dumps({'type': 'research_progress', **progress})}\n\n"
                                        except asyncio.TimeoutError:
                                            if research_task.done():
                                                break
                                            continue
                                        except Exception as e:
                                            logger.error(f"Progress streaming error: {e}")
                                            break
                                    
                                    tool_result_text = await research_task
                                elif "__" in tool_name:
                                    server, mcp_tool = tool_name.split("__", 1)
                                    tool_result = await mcp_hub.call_tool(server, mcp_tool, tool_args)
                                    tool_result_text = "\n".join([c.text for c in tool_result.content])
                                else:
                                    tool_result_text = f"Error: Tool {tool_name} is unknown."
                                obs.record_tool_call(tool_name, "ok", time.monotonic() - tool_started_at)
                                if tool_name == "deep_research":
                                    obs.record_research_task("ok")
                                logger.info(f"Tool {tool_name} executed successfully. Result length: {len(str(tool_result_text))}")
                                logger.info(f"Tool snippet: {str(tool_result_text)[:500]}")
                                tool_sources = _extract_tool_sources(tool_name, str(tool_result_text))
                                if tool_sources:
                                    yield f"data: {json.dumps({'type': 'tool_sources', 'tool_name': tool_name, 'sources': tool_sources})}\n\n"
                            except Exception as e:
                                obs.record_tool_call(tool_name, "error", time.monotonic() - tool_started_at)
                                if tool_name == "deep_research":
                                    obs.record_research_task("error")
                                logger.error(f"Error executing {tool_name}: {str(e)}", exc_info=True)
                                tool_result_text = f"Error executing {tool_name}: {str(e)}"
                            
                        # Append the execution result back into the memory window for the LLM to read
                        max_tool_chars = int(os.getenv("MAX_TOOL_RESULT_TOKENS", "1500")) * 4
                        trimmed_result = str(tool_result_text)[:max_tool_chars]
                        if len(str(tool_result_text)) > max_tool_chars:
                            trimmed_result += "\n\n[Result truncated for token budget]"

                        if is_text_tool:
                            full_messages.append(Message(role="user", content=f"[System: Tool `{tool_name}` was executed in the background. Here are the results:]\n\n{trimmed_result}\n\n[System: Now answer the user's original query naturally in markdown/plain text. Do not output JSON. Do not include thought, analysis, plan, or hidden reasoning fields.]"))
                        else:
                            full_messages.append(Message(role="tool", content=trimmed_result, tool_call_id=call["id"], name=tool_name))
                    
                    # Tool cycle processed; continue the outer while loop to synthesize final answer
                    executed_tool_this_run = True
                    continue
                else:
                    # Normal finish, check if the response was wrapped in a JSON "answer" object
                    cleaned_response = _clean_json_wrapped_response(assistant_response)
                    if cleaned_response is not None:
                        assistant_response = cleaned_response
                        total_assistant_response = total_assistant_response[:iter_response_start] + cleaned_response
                        yield f"data: {json.dumps({'type': 'response_replace', 'content': cleaned_response})}\n\n"
                    elif suppress_json_reasoning and not assistant_response.strip():
                        # Extract key readable information from full_messages if available
                        fallback_response = _extract_last_tool_summary(full_messages) or (
                            "The selected local model used its output budget on hidden reasoning. "
                            "Please ask your question again; OmniMind will synthesize directly."
                        )
                        assistant_response = fallback_response
                        total_assistant_response = total_assistant_response[:iter_response_start] + fallback_response
                        yield f"data: {json.dumps({'type': 'response_replace', 'content': fallback_response})}\n\n"
                    elif (
                        executed_tool_this_run
                        and not synthesis_retry_used
                        and iterations < max_iterations
                        and (not assistant_response.strip() or _looks_like_meta_reasoning(assistant_response))
                    ):
                        # The model restated the task / tool results (or said nothing)
                        # instead of answering. Discard that preamble and force one
                        # stricter synthesis pass with the tool results still in context.
                        synthesis_retry_used = True
                        total_assistant_response = total_assistant_response[:iter_response_start]
                        yield f"data: {json.dumps({'type': 'response_replace', 'content': ''})}\n\n"
                        full_messages.append(Message(
                            role="user",
                            content=(
                                "[System: Write the FINAL answer to the user's original question NOW in clear markdown. "
                                "Present the actual information directly — do NOT refer to 'the user', 'the search results', "
                                "or your own process, and do NOT output JSON or hidden reasoning.]"
                            ),
                        ))
                        continue
                    break

            output_tokens = count_tokens(
                [Message(role="assistant", content=total_assistant_response)],
                request.model,
            )
            obs.record_chat_tokens(request.provider, request.model, "output", output_tokens)
            await session_manager.append_message(
                request.conversation_id,
                "assistant",
                total_assistant_response,
                token_count_value=output_tokens,
            )
            await memory_engine.process_new_message(
                user_id=user_id,
                conversation_id=request.conversation_id,
                role="user",
                content=request.message,
            )
            summary = await session_manager.maybe_refresh_summary(
                conversation_id=request.conversation_id,
                user_id=user_id,
                provider=request.provider,
                model=request.model,
            )
            if summary:
                await memory_engine.store_episode(
                    user_id=user_id,
                    conversation_id=request.conversation_id,
                    summary=summary,
                )
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    async def instrumented_generator():
        # Wraps the SSE stream to record request count, time-to-first-token,
        # total duration, and in-flight stream gauge without touching the
        # (large) generator body above.
        started = time.monotonic()
        saw_first_frame = False
        status = "ok"
        obs.stream_started(request.provider)
        try:
            async for frame in event_generator():
                if not saw_first_frame:
                    saw_first_frame = True
                    obs.record_chat_ttft(request.provider, request.model, time.monotonic() - started)
                if frame.startswith('data: {"error"'):
                    status = "error"
                yield frame
        except BaseException:
            status = "error"
            raise
        finally:
            obs.stream_finished(request.provider)
            elapsed = time.monotonic() - started
            obs.record_chat_duration(request.provider, request.model, status, elapsed)
            obs.record_chat_request(request.provider, request.model, status)

    return StreamingResponse(instrumented_generator(), media_type="text/event-stream")

@router.get("/providers")
async def list_providers():
    return await registry.list_providers()

@router.get("/providers/{provider_name}/models")
async def get_provider_models(provider_name: str):
    """Live-fetch the current model list for a specific provider (useful for Ollama)."""
    instance = registry.get_provider(provider_name)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_name}' not found or not configured")
    try:
        models = await instance.get_available_models()
        return {"provider": provider_name, "models": models}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
