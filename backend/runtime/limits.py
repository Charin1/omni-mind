import asyncio
import os


CHAT_CONCURRENCY_LIMIT = int(os.getenv("CHAT_CONCURRENCY_LIMIT", "40"))
ARTIFACT_CONCURRENCY_LIMIT = int(os.getenv("ARTIFACT_CONCURRENCY_LIMIT", "8"))
COMPUTER_USE_CONCURRENCY_LIMIT = int(os.getenv("COMPUTER_USE_CONCURRENCY_LIMIT", "4"))

chat_semaphore = asyncio.Semaphore(CHAT_CONCURRENCY_LIMIT)
artifact_semaphore = asyncio.Semaphore(ARTIFACT_CONCURRENCY_LIMIT)
computer_use_semaphore = asyncio.Semaphore(COMPUTER_USE_CONCURRENCY_LIMIT)
