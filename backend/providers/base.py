from abc import ABC, abstractmethod
from typing import AsyncGenerator, List, Optional, Any
from pydantic import BaseModel

class Message(BaseModel):
    role: str
    content: str
    name: Optional[str] = None
    tool_calls: Optional[List[Any]] = None

class ModelConfig(BaseModel):
    model: Optional[str] = None
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    top_p: Optional[float] = None
    frequency_penalty: Optional[float] = None
    presence_penalty: Optional[float] = None
    stream: bool = True

class StreamChunk(BaseModel):
    content: str
    role: Optional[str] = None
    finish_reason: Optional[str] = None

class BaseLLMProvider(ABC):
    @abstractmethod
    async def chat(self, messages: List[Message], config: ModelConfig, tools: Optional[List[Any]] = None) -> AsyncGenerator[StreamChunk, None]:
        """Stream a chat completion. Every provider implements this."""
        pass
    
    @abstractmethod
    async def count_tokens(self, messages: List[Message], model: str) -> int:
        """Count tokens for context window management."""
        pass
    
    @abstractmethod
    def get_context_limit(self, model: str) -> int:
        """Return max context window size for the model."""
        pass

    @abstractmethod
    async def get_available_models(self) -> List[str]:
        """Return list of available models for this provider."""
        pass
