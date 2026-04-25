import asyncio
import os
import sys
from dotenv import load_dotenv

# Add backend to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from research.orchestrator import orchestrator

async def run_research_test():
    load_dotenv()
    
    query = "What are the latest coding features in Claude 3.7?"
    # Use Gemini since we have a key
    provider = "google"
    model = "gemini-2.0-flash" 
    
    print(f"--- Running Deep Research Test ---")
    print(f"Query: {query}")
    
    try:
        report = await orchestrator.execute_research(
            query=query,
            provider=provider,
            model=model
        )
        print("\n[SUCCESS] Research Report Generated:")
        print("-" * 30)
        print(report[:1000] + "...") # Print first 1000 chars
        print("-" * 30)
    except Exception as e:
        print(f"[FAILURE] Research failed: {e}")

if __name__ == "__main__":
    asyncio.run(run_research_test())
