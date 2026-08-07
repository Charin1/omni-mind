import os
from typing import List, Optional
from providers.base import Message
from .token_counter import count_tokens
from .summarizer import summarize_messages

class ContextManager:
    def __init__(self, limit: Optional[int] = None, trigger_threshold: float = 0.8):
        default_limit = int(os.getenv("DEFAULT_CONTEXT_LIMIT", "128000"))
        self.limit = limit if limit is not None else default_limit
        self.trigger_threshold = trigger_threshold

    async def assemble_context(
        self, 
        system_prompt: str,
        messages: List[Message],
        memories: Optional[List[str]] = None,
        conversation_summary: Optional[str] = None,
        provider: str = "openai",
        model: str = "gpt-5-mini"
    ) -> List[Message]:
        messages = list(messages)
        effective_limit = self._resolve_context_limit(provider, model)
        # Leave room for the assistant's answer. This matters most for local
        # models, where unbounded context can crowd out final generation.
        output_reserve = max(1024, int(effective_limit * 0.2))
        input_limit = max(1024, effective_limit - output_reserve)
        
        # Layer 1: System Prompt
        context = [Message(role="system", content=system_prompt)]
        
        if conversation_summary:
            context.append(
                Message(
                    role="system",
                    content=f"Conversation summary so far:\n{conversation_summary}",
                )
            )

        # Layer 2: Memories
        if memories:
            memory_context = "Relevant memories:\n" + "\n".join(memories)
            context.append(Message(role="system", content=memory_context))

        # Check token count of existing layers + new messages
        current_tokens = count_tokens(context + messages, model)
        
        if current_tokens > input_limit * self.trigger_threshold:
            # Automatic iterative context compression
            if len(messages) > 4:
                to_summarize = messages[:-4]
                recent_messages = messages[-4:]
                
                try:
                    summary = await summarize_messages(to_summarize, provider, model)
                    context.append(Message(role="system", content=f"Previous conversation summary: {summary}"))
                except Exception:
                    # Fallback if summarizer fails: truncate while retaining recent
                    pass
                
                context.extend(recent_messages)
            else:
                # Truncate oldest messages while preserving at least the latest user prompt
                while count_tokens(context + messages, model) > input_limit and len(messages) > 1:
                    messages.pop(0)
                context.extend(messages)
        else:
            context.extend(messages)

        return context

    def _resolve_context_limit(self, provider: str, model: str) -> int:
        try:
            from providers.registry import registry

            instance = registry.get_provider(provider)
            if instance:
                return min(instance.get_context_limit(model), 400000)
        except Exception:
            pass
        return int(os.getenv("DEFAULT_CONTEXT_LIMIT", "128000"))

