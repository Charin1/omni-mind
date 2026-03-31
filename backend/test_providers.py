import asyncio
from providers.registry import registry
from pprint import pprint

async def main():
    print("Listing providers dynamically...")
    res = await registry.list_providers()
    pprint(res)

if __name__ == "__main__":
    asyncio.run(main())
