import os
from typing import AsyncGenerator, List, Optional, Any
from google import genai
from .base import BaseLLMProvider, Message, ModelConfig, StreamChunk
from .registry import registry

class GoogleProvider(BaseLLMProvider):
    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.client = genai.Client(api_key=self.api_key) if self.api_key else None
        self.models = [
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
            "gemini-2.5-flash-preview-09-2025",
        ]

    async def chat(self, messages: List[Message], config: ModelConfig, tools: Optional[List[Any]] = None) -> AsyncGenerator[StreamChunk, None]:
        if not self.client:
            raise ValueError("Google API key not found")

        # Combine messages into a single chat list
        contents = []
        for m in messages:
            contents.append({"role": "user" if m.role == "user" else "model", "parts": [{"text": m.content}]})

        # generate_content_stream is a coroutine that resolves to the async
        # iterator - iterating it without awaiting raises
        # "'async for' requires an object with __aiter__ method, got coroutine".
        response = await self.client.aio.models.generate_content_stream(
            model=config.model if hasattr(config, "model") else "gemini-2.5-flash",
            contents=contents,
            config={
                "temperature": config.temperature,
                "max_output_tokens": config.max_tokens,
            }
        )

        async for chunk in response:
            if chunk.text:
                yield StreamChunk(
                    content=chunk.text,
                    role="assistant"
                )

    async def count_tokens(self, messages: List[Message], model: str) -> int:
        # Google SDK has a simple token counter
        if not self.client: return 0
        res = await self.client.aio.models.count_tokens(
            model=model,
            contents=[m.content for m in messages]
        )
        return res.total_tokens

    def get_context_limit(self, model: str) -> int:
        if "pro" in model: return 2000000
        return 1000000

    async def get_available_models(self) -> List[str]:
        try:
            if not self.client:
                return self.models
            # In genai SDK, available models can be iterated
            models = self.client.models.list()
            return [m.name for m in models]
        except Exception:
            return self.models

# Register the provider
registry.register("google", GoogleProvider)
