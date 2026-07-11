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
        # Google's native API namespaces models as "models/gemini-2.5-flash";
        # that prefix means nothing to litellm, so strip it before routing.
        if provider == "google" and model.startswith("models/"):
            model = model.split("/", 1)[1]

        prefixes = {
            "openai": "openai",
            "anthropic": "anthropic",
            "google": "gemini",
            "ollama": "ollama",
        }
        prefix = prefixes.get(provider)
        if not prefix:
            return model
        if model.startswith(f"{prefix}/"):
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
            tool_calls = getattr(delta, "tool_calls", None) if delta else None
            
            if content or tool_calls or getattr(choice, "finish_reason", None) == "tool_calls":
                yield StreamChunk(
                    content=content,
                    role="assistant",
                    tool_calls=tool_calls,
                    finish_reason=getattr(choice, "finish_reason", None),
                )
    async def chat(
        self,
        provider: str,
        messages: List[Message],
        config: ModelConfig,
    ) -> str:
        if not self.available:
            raise RuntimeError("LiteLLM is not installed")

        litellm_model = self.resolve_model(provider, config.model or "")
        payload: Dict[str, Any] = {
            "model": litellm_model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": config.temperature,
        }
        if config.max_tokens is not None:
            payload["max_tokens"] = config.max_tokens
        if provider == "ollama":
            payload["api_base"] = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

        response = await self._acompletion(**payload)
        return response.choices[0].message.content or ""
