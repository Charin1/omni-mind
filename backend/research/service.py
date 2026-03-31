import datetime
import uuid
from typing import List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import TaskRun, TaskStep


class ResearchService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_plan(
        self,
        user_id: str,
        conversation_id: str,
        prompt: str,
    ) -> TaskRun:
        task = TaskRun(
            id=str(uuid.uuid4()),
            user_id=user_id,
            conversation_id=conversation_id,
            kind="research",
            title=self._build_title(prompt),
            status="planned",
            input_prompt=prompt,
            summary="Initial research plan created from chat request.",
        )
        self.db.add(task)
        await self.db.flush()

        for index, step in enumerate(self._build_steps(prompt), start=1):
            self.db.add(
                TaskStep(
                    id=str(uuid.uuid4()),
                    task_id=task.id,
                    position=index,
                    title=step["title"],
                    description=step["description"],
                    status="pending" if index > 1 else "ready",
                )
            )

        await self.db.commit()
        return task

    async def get_steps(self, task_id: str) -> List[TaskStep]:
        result = await self.db.execute(
            select(TaskStep)
            .where(TaskStep.task_id == task_id)
            .order_by(TaskStep.position.asc())
        )
        return list(result.scalars().all())

    async def list_tasks(self, user_id: str) -> List[TaskRun]:
        result = await self.db.execute(
            select(TaskRun)
            .where(TaskRun.user_id == user_id)
            .order_by(TaskRun.updated_at.desc())
        )
        return list(result.scalars().all())

    def render_plan_message(self, task: TaskRun, steps: List[TaskStep]) -> str:
        lines = [
            f"I created a research plan: {task.title}",
            f"Task ID: {task.id}",
            "",
            "Planned steps:",
        ]
        for step in steps:
            lines.append(f"{step.position}. {step.title} - {step.description}")
        lines.append("")
        lines.append("You can keep chatting in this thread while we expand execution next.")
        return "\n".join(lines)

    def _build_title(self, prompt: str) -> str:
        trimmed = prompt.strip().replace("\n", " ")
        return trimmed[:80] if trimmed else "Research Task"

    def _build_steps(self, prompt: str):
        return [
            {
                "title": "Scope the question",
                "description": f"Clarify the main objective and success criteria for: {prompt[:120]}",
            },
            {
                "title": "Collect evidence",
                "description": "Gather the strongest primary sources, MCP data, and internal context relevant to the request.",
            },
            {
                "title": "Synthesize findings",
                "description": "Compare evidence, resolve conflicts, and turn the raw material into a coherent answer.",
            },
            {
                "title": "Prepare deliverable",
                "description": "Produce the final response, report, or artifact with actionable recommendations.",
            },
        ]
