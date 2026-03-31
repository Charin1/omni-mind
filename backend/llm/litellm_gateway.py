import os
from typing import Any, AsyncGenerator, Dict, List, Optional

from providers.base import Message, ModelConfig, StreamChunk


class LiteLLMGateway:
    def __init__(self):
        try:
            from litellm import acompletion
        except ImportError:
            acompletion = None
        self._acompletion = acompletion

    @property
    def available(self) -> bool:
        return self._acompletion is not None

    def resolve_model(self, provider: str, model: str) -> str:
        if "/" in model:
            return model

        prefixes = {
            "openai": "openai",
            "anthropic": "anthropic",
            "google": "gemini",
            "ollama": "ollama",
        }
        prefix = prefixes.get(provider)
        if not prefix:
            return model
        return f"{prefix}/{model}"

    async def stream_chat(
        self,
        provider: str,
        messages: List[Message],
        config: ModelConfig,
        tools: Optional[List[Any]] = None,
    ) -> AsyncGenerator[StreamChunk, None]:
        if not self.available:
            raise RuntimeError("LiteLLM is not installed")

        litellm_model = self.resolve_model(provider, config.model or "")
        payload: Dict[str, Any] = {
            "model": litellm_model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "temperature": config.temperature,
        }
        if config.max_tokens is not None:
            payload["max_tokens"] = config.max_tokens
        if tools:
            payload["tools"] = tools
        if provider == "ollama":
            payload["api_base"] = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

        response = await self._acompletion(**payload)
        async for chunk in response:
            choice = chunk.choices[0] if getattr(chunk, "choices", None) else None
            delta = choice.delta if choice else None
            content = getattr(delta, "content", None) if delta else None
            if content:
                yield StreamChunk(
                    content=content,
                    role="assistant",
                    finish_reason=getattr(choice, "finish_reason", None),
                )
