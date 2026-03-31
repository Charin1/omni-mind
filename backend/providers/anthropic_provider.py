import os
from typing import AsyncGenerator, List, Optional, Any
from anthropic import AsyncAnthropic
from .base import BaseLLMProvider, Message, ModelConfig, StreamChunk
from .registry import registry

class AnthropicProvider(BaseLLMProvider):
    def __init__(self):
        self.client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
        self.models = [
            "claude-opus-4-1-20250805",
            "claude-sonnet-4-20250514",
            "claude-3-7-sonnet-latest",
            "claude-3-5-haiku-latest",
        ]

    async def chat(self, messages: List[Message], config: ModelConfig, tools: Optional[List[Any]] = None) -> AsyncGenerator[StreamChunk, None]:
        # Anthropic likes system prompt separate from messages
        system_prompt = ""
        user_messages = []
        for m in messages:
            if m.role == "system":
                system_prompt = m.content
            else:
                user_messages.append({"role": m.role, "content": m.content})

        async with self.client.messages.stream(
            model=config.model if hasattr(config, "model") else "claude-sonnet-4-20250514",
            max_tokens=config.max_tokens or 4096,
            temperature=config.temperature,
            system=system_prompt,
            messages=user_messages
        ) as stream:
            async for chunk in stream:
                if chunk.type == "content_block_delta" and chunk.delta.type == "text_delta":
                    yield StreamChunk(
                        content=chunk.delta.text,
                        role="assistant"
                    )

    async def count_tokens(self, messages: List[Message], model: str) -> int:
        # Approximate: Anthropic SDK provides counter, but for brevity here:
        total_chars = sum(len(m.content) for m in messages)
        return total_chars // 4

    def get_context_limit(self, model: str) -> int:
        return 200000

    async def get_available_models(self) -> List[str]:
        try:
            models_page = await self.client.models.list()
            return [m.id for m in models_page.data]
        except Exception:
            return self.models

# Register the provider
registry.register("anthropic", AnthropicProvider)
