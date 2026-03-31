from typing import Any, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from db.models import Artifact
from tools.artifacts import ArtifactService

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])


class ArtifactResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: Optional[str] = None
    conversation_id: Optional[str] = None
    kind: str
    name: str
    path: str
    mime_type: str
    status: str
    metadata_json: Optional[Any] = None
    created_at: Any


class ArtifactCreateRequest(BaseModel):
    user_id: str = "local-user"
    conversation_id: str
    kind: str
    prompt: str


@router.get("", response_model=List[ArtifactResponse])
async def list_artifacts(
    user_id: str = "local-user",
    conversation_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    query = select(Artifact).where(Artifact.user_id == user_id)
    if conversation_id:
        query = query.where(Artifact.conversation_id == conversation_id)
    result = await db.execute(query.order_by(Artifact.created_at.desc()))
    return result.scalars().all()


@router.post("", response_model=ArtifactResponse)
async def create_artifact(
    data: ArtifactCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    service = ArtifactService(db)
    artifact = await service.generate_artifact(
        kind=data.kind,
        user_id=data.user_id,
        conversation_id=data.conversation_id,
        prompt=data.prompt,
    )
    return artifact
