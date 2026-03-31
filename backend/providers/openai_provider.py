import os
from typing import AsyncGenerator, List, Optional, Any
from openai import AsyncOpenAI
import tiktoken
from .base import BaseLLMProvider, Message, ModelConfig, StreamChunk
from .registry import registry

class OpenAIProvider(BaseLLMProvider):
    def __init__(self):
        self.client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.models = [
            "gpt-5.2",
            "gpt-5.2-pro",
            "gpt-5-mini",
            "gpt-5-nano",
            "o3",
            "o4-mini",
        ]

    async def chat(self, messages: List[Message], config: ModelConfig, tools: Optional[List[Any]] = None) -> AsyncGenerator[StreamChunk, None]:
        formatted_messages = [{"role": m.role, "content": m.content} for m in messages]
        
        response = await self.client.chat.completions.create(
            model=config.model if hasattr(config, "model") else "gpt-5-mini",
            messages=formatted_messages,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
            top_p=config.top_p,
            frequency_penalty=config.frequency_penalty,
            presence_penalty=config.presence_penalty,
            stream=True,
            tools=tools
        )

        async for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                yield StreamChunk(
                    content=chunk.choices[0].delta.content,
                    role="assistant",
                    finish_reason=chunk.choices[0].finish_reason
                )

    async def count_tokens(self, messages: List[Message], model: str) -> int:
        try:
            encoding = tiktoken.encoding_for_model(model)
        except KeyError:
            encoding = tiktoken.get_encoding("cl100k_base")
        
        num_tokens = 0
        for message in messages:
            num_tokens += 4  # every message follows <im_start>{role/name}\n{content}<im_end>\n
            num_tokens += len(encoding.encode(message.content))
            if message.name:
                num_tokens += -1  # role is omitted
        num_tokens += 2  # every reply is primed with <im_start>assistant
        return num_tokens

    def get_context_limit(self, model: str) -> int:
        limits = {
            "gpt-5.2": 400000,
            "gpt-5.2-pro": 400000,
            "gpt-5-mini": 400000,
            "gpt-5-nano": 400000,
            "o3": 200000,
            "o4-mini": 200000,
        }
        return limits.get(model, 128000)

    async def get_available_models(self) -> List[str]:
        try:
            models_list = await self.client.models.list()
            return [m.id for m in models_list.data]
        except Exception:
            return self.models

# Register the provider
registry.register("openai", OpenAIProvider)
