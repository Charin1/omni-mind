import os
import json
import httpx
from typing import AsyncGenerator, List, Optional, Any
from .base import BaseLLMProvider, Message, ModelConfig, StreamChunk
from .registry import registry

class OllamaProvider(BaseLLMProvider):
    def __init__(self):
        self.base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        self._models = []

    async def chat(self, messages: List[Message], config: ModelConfig, tools: Optional[List[Any]] = None) -> AsyncGenerator[StreamChunk, None]:
        url = f"{self.base_url}/api/chat"
        payload = {
            "model": config.model if hasattr(config, "model") else "llama3",
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "options": {
                "temperature": config.temperature,
                "num_predict": config.max_tokens,
                "top_p": config.top_p,
            }
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, json=payload) as response:
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    data = json.loads(line)
                    if "message" in data:
                        yield StreamChunk(
                            content=data["message"].get("content", ""),
                            role="assistant",
                            finish_reason="stop" if data.get("done") else None
                        )

    async def count_tokens(self, messages: List[Message], model: str) -> int:
        # Approximate for Ollama as it varies by model
        total_chars = sum(len(m.content) for m in messages)
        return total_chars // 4

    def get_context_limit(self, model: str) -> int:
        # Default for most local models, can be configured
        return 8192

    async def get_available_models(self) -> List[str]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(f"{self.base_url}/api/tags")
                if res.status_code == 200:
                    data = res.json()
                    return [m["name"] for m in data.get("models", [])]
        except Exception:
            pass
        return ["llama3.2", "qwen3", "qwen2.5", "gemma3", "mistral"]

# Register the provider
registry.register("ollama", OllamaProvider)
