from typing import Any, Dict, Optional, TypedDict

from agents.action_router import ActionRouter
from research.service import ResearchService
from tools.artifacts import ArtifactService


class WorkflowState(TypedDict, total=False):
    user_id: str
    conversation_id: str
    message: str
    mode: str
    artifact_kind: Optional[str]
    response_text: Optional[str]
    task_id: Optional[str]


class GraphRuntime:
    def __init__(
        self,
        action_router: ActionRouter,
        artifact_service: ArtifactService,
        research_service: ResearchService,
    ):
        self.action_router = action_router
        self.artifact_service = artifact_service
        self.research_service = research_service
        self._graph = self._build_graph()

    def _build_graph(self):
        try:
            from langgraph.graph import END, START, StateGraph
        except ImportError:
            return None

        async def decide_node(state: WorkflowState) -> WorkflowState:
            decision = self.action_router.decide(state["message"])
            return {
                "mode": decision.mode,
                "artifact_kind": decision.artifact_kind,
            }

        async def artifact_node(state: WorkflowState) -> WorkflowState:
            artifact = await self.artifact_service.generate_artifact(
                kind=state["artifact_kind"] or "html",
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                prompt=state["message"],
            )
            artifact_url = self.artifact_service.public_url(artifact)
            return {
                "response_text": (
                    f"I created a {artifact.kind} artifact for you.\n"
                    f"File: {artifact.name}\n"
                    f"URL: {artifact_url}"
                )
            }

        async def research_node(state: WorkflowState) -> WorkflowState:
            task = await self.research_service.create_plan(
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                prompt=state["message"],
            )
            steps = await self.research_service.get_steps(task.id)
            return {
                "task_id": task.id,
                "response_text": self.research_service.render_plan_message(task, steps),
            }

        async def chat_node(state: WorkflowState) -> WorkflowState:
            return {"mode": "chat"}

        def route(state: WorkflowState) -> str:
            return state.get("mode", "chat")

        graph = StateGraph(WorkflowState)
        graph.add_node("decide", decide_node)
        graph.add_node("artifact", artifact_node)
        graph.add_node("research", research_node)
        graph.add_node("chat", chat_node)
        graph.add_edge(START, "decide")
        graph.add_conditional_edges(
            "decide",
            route,
            {
                "artifact": "artifact",
                "research": "research",
                "chat": "chat",
            },
        )
        graph.add_edge("artifact", END)
        graph.add_edge("research", END)
        graph.add_edge("chat", END)
        return graph.compile()

    async def preflight(
        self,
        user_id: str,
        conversation_id: str,
        message: str,
    ) -> WorkflowState:
        initial_state: WorkflowState = {
            "user_id": user_id,
            "conversation_id": conversation_id,
            "message": message,
        }
        if self._graph is not None:
            return await self._graph.ainvoke(initial_state)

        decision = self.action_router.decide(message)
        if decision.mode == "artifact" and decision.artifact_kind:
            artifact = await self.artifact_service.generate_artifact(
                kind=decision.artifact_kind,
                user_id=user_id,
                conversation_id=conversation_id,
                prompt=message,
            )
            return {
                "mode": "artifact",
                "artifact_kind": decision.artifact_kind,
                "response_text": (
                    f"I created a {artifact.kind} artifact for you.\n"
                    f"File: {artifact.name}\n"
                    f"URL: {self.artifact_service.public_url(artifact)}"
                ),
            }
        if decision.mode == "research":
            task = await self.research_service.create_plan(
                user_id=user_id,
                conversation_id=conversation_id,
                prompt=message,
            )
            steps = await self.research_service.get_steps(task.id)
            return {
                "mode": "research",
                "task_id": task.id,
                "response_text": self.research_service.render_plan_message(task, steps),
            }
        return {"mode": "chat"}
