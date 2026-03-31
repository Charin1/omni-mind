from typing import List, Optional
from providers.base import Message
from .token_counter import count_tokens
from .summarizer import summarize_messages

class ContextManager:
    def __init__(self, limit: int = 4000, trigger_threshold: float = 0.8):
        self.limit = limit
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
        
        if current_tokens > self.limit * self.trigger_threshold:
            # Need to summarize or truncate
            # Keep last 5 messages + summary of the rest
            if len(messages) > 10:
                to_summarize = messages[:-5]
                recent_messages = messages[-5:]
                
                summary = await summarize_messages(to_summarize, provider, model)
                context.append(Message(role="system", content=f"Previous conversation summary: {summary}"))
                context.extend(recent_messages)
            else:
                # Just truncate the oldest
                while count_tokens(context + messages, model) > self.limit and len(messages) > 1:
                    messages.pop(0)
                context.extend(messages)
        else:
            context.extend(messages)

        return context
