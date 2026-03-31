from typing import Any, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from db.models import TaskRun, TaskStep
from research.service import ResearchService

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


class TaskRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: Optional[str] = None
    conversation_id: Optional[str] = None
    kind: str
    title: str
    status: str
    input_prompt: str
    summary: Optional[str] = None
    metadata_json: Optional[Any] = None
    created_at: Any
    updated_at: Any


class TaskStepResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    task_id: str
    position: int
    title: str
    description: str
    status: str
    output_text: Optional[str] = None
    created_at: Any
    updated_at: Any


class TaskDetailResponse(BaseModel):
    task: TaskRunResponse
    steps: List[TaskStepResponse]


class TaskCreateRequest(BaseModel):
    user_id: str = "local-user"
    conversation_id: str
    prompt: str


@router.get("", response_model=List[TaskRunResponse])
async def list_tasks(
    user_id: str = "local-user",
    db: AsyncSession = Depends(get_db),
):
    service = ResearchService(db)
    return await service.list_tasks(user_id)


@router.post("", response_model=TaskDetailResponse)
async def create_task(
    data: TaskCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    service = ResearchService(db)
    task = await service.create_plan(
        user_id=data.user_id,
        conversation_id=data.conversation_id,
        prompt=data.prompt,
    )
    steps = await service.get_steps(task.id)
    return {"task": task, "steps": steps}
