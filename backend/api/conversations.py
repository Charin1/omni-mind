from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import List, Optional, Any
from pydantic import BaseModel, ConfigDict
import uuid

from db.database import get_db
from db.models import Conversation, Message as DBMessage

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


class ConversationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: Optional[str] = None
    title: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    created_at: Any
    updated_at: Any


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    conversation_id: str
    role: str
    content: str
    token_count: Optional[int] = None
    created_at: Any


class ConversationDetailResponse(BaseModel):
    conversation: ConversationResponse
    messages: List[MessageResponse]

@router.get("", response_model=List[ConversationResponse])
async def list_conversations(
    user_id: str = "local-user",
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Conversation)
        .where(Conversation.user_id == user_id)
        .order_by(Conversation.updated_at.desc())
    )
    return result.scalars().all()

class ConversationCreate(BaseModel):
    title: str = "New Chat"
    user_id: str = "local-user"

@router.post("", response_model=ConversationResponse)
async def create_conversation(data: ConversationCreate, db: AsyncSession = Depends(get_db)):
    conv_id = str(uuid.uuid4())
    new_conv = Conversation(id=conv_id, title=data.title, user_id=data.user_id)
    db.add(new_conv)
    await db.commit()
    await db.refresh(new_conv)
    return new_conv

class ConversationUpdate(BaseModel):
    title: str

@router.patch("/{id}", response_model=ConversationResponse)
async def update_conversation(id: str, data: ConversationUpdate, db: AsyncSession = Depends(get_db)):
    conv = await db.get(Conversation, id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    conv.title = data.title
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return conv

@router.get("/{id}", response_model=ConversationDetailResponse)
async def get_conversation(id: str, db: AsyncSession = Depends(get_db)):
    conv = await db.get(Conversation, id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    
    messages = await db.execute(select(DBMessage).where(DBMessage.conversation_id == id).order_by(DBMessage.created_at.asc()))
    return {
        "conversation": conv,
        "messages": messages.scalars().all()
    }

@router.delete("/{id}")
async def delete_conversation(id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(DBMessage).where(DBMessage.conversation_id == id))
    await db.execute(delete(Conversation).where(Conversation.id == id))
    await db.commit()
    return {"message": "Deleted"}
