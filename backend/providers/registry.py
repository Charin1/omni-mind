from typing import Dict, Type, Optional
from .base import BaseLLMProvider

class ProviderRegistry:
    _providers: Dict[str, Type[BaseLLMProvider]] = {}
    _instances: Dict[str, BaseLLMProvider] = {}

    @classmethod
    def register(cls, name: str, provider_class: Type[BaseLLMProvider]):
        cls._providers[name] = provider_class

    @classmethod
    def get_provider(cls, name: str) -> Optional[BaseLLMProvider]:
        if name in cls._instances:
            return cls._instances[name]
        
        if name in cls._providers:
            try:
                instance = cls._providers[name]()
                cls._instances[name] = instance
                return instance
            except Exception:
                return None
        
        return None

    @classmethod
    async def list_providers(cls) -> Dict[str, list]:
        result = {}
        for name, provider_class in cls._providers.items():
            # Create a temporary instance to get models or make it a class method
            instance = cls.get_provider(name)
            if instance:
                result[name] = await instance.get_available_models()
        return result

# Singleton registry
registry = ProviderRegistry()
