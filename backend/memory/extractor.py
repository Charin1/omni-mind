import json
from typing import List, Optional
from providers.base import Message, ModelConfig
from providers.registry import registry

class FactExtractor:
    def __init__(self, provider_name: str = "openai", model: str = "gpt-5-mini"):
        self.provider_name = provider_name
        self.model = model

    async def extract_facts(self, message: str) -> List[dict]:
        """Extract structured facts/preferences from a user message."""
        provider = registry.get_provider(self.provider_name)
        if not provider:
            return []

        prompt = """
        Extract key facts, preferences, or decisions from the user's message.
        Return a JSON list of objects with 'fact', 'type' (preference/decision/fact/event), and 'importance' (0.0 to 1.0).
        Only extract significant information that would be useful for future sessions.
        If no significant facts are found, return an empty list [].
        
        Example Output:
        [{"fact": "User prefers dark mode", "type": "preference", "importance": 0.8}]
        """

        messages = [
            Message(role="system", content=prompt),
            Message(role="user", content=message)
        ]

        config = ModelConfig(model=self.model, temperature=0.1, max_tokens=500)
        
        response_text = ""
        async for chunk in provider.chat(messages, config):
            if chunk.content:
                response_text += chunk.content

        try:
            # Clean possible markdown formatting
            cleaned = response_text.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:-3]
            elif cleaned.startswith("```"):
                cleaned = cleaned[3:-3]
            
            return json.loads(cleaned.strip())
        except Exception:
            return []
