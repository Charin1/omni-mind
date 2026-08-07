import os
import json
import logging
import httpx
from typing import AsyncGenerator, List, Optional, Any
from .base import BaseLLMProvider, Message, ModelConfig, StreamChunk
from .registry import registry

logger = logging.getLogger("uvicorn.error")

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
        try:
            return int(os.getenv("OLLAMA_NUM_CTX", "16384"))
        except ValueError:
            return 16384

    async def get_available_models(self) -> List[str]:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(f"{self.base_url}/api/tags")
                if res.status_code == 200:
                    data = res.json()
                    # Ollama returns full names like 'llama3.2:latest', we keep them as is
                    return [m["name"] for m in data.get("models", [])]
                else:
                    logger.warning(f"Ollama tags returned status {res.status_code}")
        except Exception as e:
            logger.error(f"Failed to fetch Ollama models: {e}")
        
        return [] # Return empty list so UI knows Ollama is offline or has no models

# Register the provider
registry.register("ollama", OllamaProvider)
