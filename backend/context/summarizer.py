from typing import List
from providers.base import Message, ModelConfig
from providers.registry import registry

async def summarize_messages(messages: List[Message], provider_name: str = "openai", model: str = "gpt-5-mini") -> str:
    if not messages:
        return ""

    provider = registry.get_provider(provider_name)
    if not provider:
        return "Failed to summarize: provider not found."

    summary_prompt = "Summarize the following conversation, preserving all key facts, decisions, and action items in 3-4 concise sentences."
    
    # Format messages for the summarizer
    formatted_chat = "\n".join([f"{m.role}: {m.content}" for m in messages])
    
    prompt_messages = [
        Message(role="system", content=summary_prompt),
        Message(role="user", content=formatted_chat)
    ]
    
    config = ModelConfig(model=model, temperature=0.3, max_tokens=300)
    
    summary = ""
    async for chunk in provider.chat(prompt_messages, config):
        summary += chunk.content
    
    return summary.strip()
