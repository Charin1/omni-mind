from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List

from db.database import get_db
from db.models import Memory, Episode

router = APIRouter(prefix="/api/memory", tags=["memory"])

@router.get("")
async def list_memories(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Memory).order_by(Memory.created_at.desc()))
    return result.scalars().all()

@router.get("/episodes/{conversation_id}")
async def get_episodes(conversation_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Episode).where(Episode.conversation_id == conversation_id).order_by(Episode.created_at.desc()))
    return result.scalars().all()

@router.get("/stats")
async def memory_stats(db: AsyncSession = Depends(get_db)):
    mem_count = await db.execute(select(Memory.id))
    epi_count = await db.execute(select(Episode.id))
    return {
        "total_memories": len(mem_count.scalars().all()),
        "total_episodes": len(epi_count.scalars().all())
    }
