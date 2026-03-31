import uuid
from typing import List

from .vector_store import VectorStore
from .extractor import FactExtractor
from db.models import Memory, Episode
from sqlalchemy.ext.asyncio import AsyncSession

class MemoryEngine:
    def __init__(
        self,
        db_session: AsyncSession,
        vector_store: VectorStore,
        provider_name: str = "openai",
        model: str = "gpt-5-mini",
    ):
        self.db = db_session
        self.vector_store = vector_store
        self.extractor = FactExtractor(provider_name=provider_name, model=model)

    async def process_new_message(
        self,
        user_id: str,
        conversation_id: str,
        role: str,
        content: str,
    ):
        """Extract facts and store in memory if the role is user."""
        if role != "user":
            return

        facts = await self.extractor.extract_facts(content)
        for f in facts:
            await self.add_memory(
                user_id=user_id,
                conversation_id=conversation_id,
                content=f['fact'],
                memory_type=f['type'],
                importance=f.get('importance', 0.5),
                tags=f.get('tags', [])
            )

    async def add_memory(
        self,
        user_id: str,
        conversation_id: str,
        content: str,
        memory_type: str,
        importance: float = 0.5,
        tags: List[str] = None,
    ):
        memory_id = str(uuid.uuid4())
        
        # 1. Store in SQL for management
        new_memory = Memory(
            id=memory_id,
            user_id=user_id,
            conversation_id=conversation_id,
            type=memory_type,
            content=content,
            importance=importance,
            tags=tags or []
        )
        self.db.add(new_memory)
        await self.db.commit()

        # 2. Store in Vector DB for semantic retrieval
        self.vector_store.add_memory(
            id=memory_id,
            text=content,
            metadata={
                "user_id": user_id,
                "conversation_id": conversation_id,
                "type": memory_type,
                "importance": importance,
            }
        )

    async def retrieve_relevant_memories(
        self,
        user_id: str,
        query: str,
        top_k: int = 5,
    ) -> List[str]:
        """Perform semantic search for context assembly."""
        results = self.vector_store.search(
            query,
            top_k=top_k,
            metadata_filter={"user_id": user_id},
        )
        return [
            r['content']
            for r in results
            if r['distance'] is None or r['distance'] < 0.4
        ]

    async def store_episode(self, user_id: str, conversation_id: str, summary: str):
        episode_id = str(uuid.uuid4())
        new_episode = Episode(
            id=episode_id,
            user_id=user_id,
            conversation_id=conversation_id,
            summary=summary
        )
        self.db.add(new_episode)
        await self.db.commit()
