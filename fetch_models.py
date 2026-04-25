import asyncio
import json
import os
import sys

# Add backend to path so we can import the providers
sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))

from dotenv import load_dotenv
load_dotenv()

from providers.registry import registry
import providers  # Loads all providers

async def main():
    print("Fetching available models from configured providers...")
    
    # This calls the get_available_models method for each provider
    models_dict = await registry.list_providers()
    
    # Path where frontend expects the model fallback file
    frontend_models_path = os.path.join(os.path.dirname(__file__), "frontend", "src", "lib", "models.json")
    
    # Ensure directory exists
    os.makedirs(os.path.dirname(frontend_models_path), exist_ok=True)
    
    with open(frontend_models_path, "w") as f:
        json.dump(models_dict, f, indent=2)
        
    print(f"Successfully wrote models configuration to {frontend_models_path}")
    for provider, models in models_dict.items():
        print(f" - {provider}: {len(models)} models found")

if __name__ == "__main__":
    asyncio.run(main())
