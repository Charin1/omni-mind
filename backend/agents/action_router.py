from dataclasses import dataclass
from typing import Optional

from tools.artifacts import ArtifactService


@dataclass
class ActionDecision:
    mode: str
    artifact_kind: Optional[str] = None


class ActionRouter:
    def __init__(self, artifact_service: ArtifactService):
        self.artifact_service = artifact_service

    def decide(self, message: str) -> ActionDecision:
        artifact_kind = self.artifact_service.detect_kind(message)
        if artifact_kind:
            return ActionDecision(mode="artifact", artifact_kind=artifact_kind)

        lowered = message.lower()
        research_keywords = [
            "research",
            "deep dive",
            "investigate",
            "analyze",
            "compare",
            "find sources",
            "prepare a report",
            "market scan",
        ]
        if any(keyword in lowered for keyword in research_keywords):
            return ActionDecision(mode="research")

        return ActionDecision(mode="chat")
