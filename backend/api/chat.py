from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional, Any
import json
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
from app_mcp.client import mcp_hub
from app_mcp.tool_converter import ToolConverter
from research.service import ResearchService
from runtime.limits import chat_semaphore
from tools.artifacts import ArtifactService

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatSettings(BaseModel):
    system_prompt: Optional[str] = None
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = None


class ChatRequest(BaseModel):
    conversation_id: str
    user_id: Optional[str] = "local-user"
    message: str
    provider: str
    model: str
    history: List[Message] = []
    settings: Optional[ChatSettings] = None


context_manager = ContextManager()
vector_store = VectorStore()
llm_gateway = LiteLLMGateway()

@router.post("")
async def chat(request: ChatRequest, db: AsyncSession = Depends(get_db)):
    provider = registry.get_provider(request.provider)
    if not provider:
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

    await session_manager.ensure_conversation(
        conversation_id=request.conversation_id,
        user_id=user_id,
        provider=request.provider,
        model=request.model,
        title=request.message[:60],
    )

    persisted_messages, stored_summary = await session_manager.build_context_messages(
        request.conversation_id
    )
    history_messages = persisted_messages or request.history

    # 1. Retrieve tools from MCP Hub
    mcp_tools = await mcp_hub.list_tools()
    llm_tools = []
    if mcp_tools:
        if request.provider == "openai":
            llm_tools = ToolConverter.to_openai(mcp_tools)
        elif request.provider == "anthropic":
            llm_tools = ToolConverter.to_anthropic(mcp_tools)
        elif request.provider == "google":
            llm_tools = ToolConverter.to_google(mcp_tools)

    # 2. Retrieve relevant memories
    memories = await memory_engine.retrieve_relevant_memories(user_id, request.message)
    
    # 3. Assemble context
    system_prompt = (
        request.settings.system_prompt
        if request.settings and request.settings.system_prompt
        else "You are OmniMind, a helpful AI assistant."
    )
    
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
        max_tokens=request.settings.max_tokens if request.settings else None,
    )

    async def event_generator():
        try:
            await session_manager.append_message(
                request.conversation_id,
                "user",
                request.message,
                token_count_value=count_tokens([user_message], request.model),
            )

            workflow_result = await graph_runtime.preflight(
                user_id=user_id,
                conversation_id=request.conversation_id,
                message=request.message,
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

            assistant_response = ""
            async with chat_semaphore:
                if llm_gateway.available:
                    async for chunk in llm_gateway.stream_chat(
                        provider=request.provider,
                        messages=full_messages,
                        config=config,
                        tools=llm_tools if llm_tools else None,
                    ):
                        assistant_response += chunk.content
                        yield f"data: {json.dumps({'content': chunk.content, 'role': 'assistant'})}\n\n"
                else:
                    async for chunk in provider.chat(full_messages, config, tools=llm_tools if llm_tools else None):
                        # Note: Real tool-calling requires parsing chunk.tool_calls and re-injecting results
                        # For this baseline, we focus on the core chat stream
                        assistant_response += chunk.content
                        yield f"data: {json.dumps({'content': chunk.content, 'role': 'assistant'})}\n\n"

            await session_manager.append_message(
                request.conversation_id,
                "assistant",
                assistant_response,
                token_count_value=count_tokens(
                    [Message(role="assistant", content=assistant_response)],
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
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@router.get("/providers")
async def list_providers():
    return await registry.list_providers()
