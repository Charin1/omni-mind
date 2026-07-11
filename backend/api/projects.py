from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, update
from typing import List, Optional, Any
from pydantic import BaseModel, ConfigDict
import datetime
import uuid

from db.database import get_db
from db.models import Project, Conversation

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: Optional[str] = None
    name: str
    description: Optional[str] = None
    instructions: Optional[str] = None
    created_at: Any
    updated_at: Any


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    instructions: Optional[str] = None
    user_id: str = "local-user"


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    instructions: Optional[str] = None


@router.get("", response_model=List[ProjectResponse])
async def list_projects(
    user_id: str = "local-user",
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Project)
        .where(Project.user_id == user_id)
        .order_by(Project.updated_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=ProjectResponse)
async def create_project(data: ProjectCreate, db: AsyncSession = Depends(get_db)):
    project = Project(
        id=str(uuid.uuid4()),
        user_id=data.user_id,
        name=data.name,
        description=data.description,
        instructions=data.instructions,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


@router.patch("/{id}", response_model=ProjectResponse)
async def update_project(id: str, data: ProjectUpdate, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    project.updated_at = datetime.datetime.utcnow()
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


@router.delete("/{id}")
async def delete_project(id: str, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    # Unlink conversations instead of deleting them so chat history survives.
    await db.execute(
        update(Conversation)
        .where(Conversation.project_id == id)
        .values(project_id=None)
    )
    await db.execute(delete(Project).where(Project.id == id))
    await db.commit()
    return {"message": "Deleted"}
