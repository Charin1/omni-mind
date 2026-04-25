"""
Tool Approval system — in-memory store that allows the SSE chat loop
to pause and wait for user approval before executing a computer-use tool.

Flow:
1. Chat loop creates an approval request → stores it here → streams
   a `tool_approval_request` SSE event to the frontend.
2. Frontend displays the approval card → user clicks Approve / Reject.
3. Frontend calls POST /api/tool-approval with the decision.
4. This module resolves the asyncio.Event so the chat loop continues.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tool-approval", tags=["tool-approval"])


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class ApprovalRequest:
    """Represents a pending approval for a single tool call."""

    approval_id: str
    tool_name: str
    tool_args: dict
    display_summary: str  # human-readable summary for the UI header
    display_detail: str  # full content (command text / file content) for the UI body
    created_at: float = field(default_factory=time.time)
    event: asyncio.Event = field(default_factory=asyncio.Event)
    approved: Optional[bool] = None  # None = pending, True = approved, False = rejected
    reject_reason: Optional[str] = None


# In-memory store — keyed by approval_id
_pending: Dict[str, ApprovalRequest] = {}

# Auto-cleanup: requests older than 10 minutes are garbage-collected
_EXPIRY_SECONDS = 600


# ---------------------------------------------------------------------------
# Public API (used by the chat loop)
# ---------------------------------------------------------------------------


def create_approval(
    tool_name: str,
    tool_args: dict,
    display_summary: str,
    display_detail: str,
) -> ApprovalRequest:
    """Create a new approval request and store it. Returns the request object."""
    _gc_expired()
    approval_id = str(uuid.uuid4())
    req = ApprovalRequest(
        approval_id=approval_id,
        tool_name=tool_name,
        tool_args=tool_args,
        display_summary=display_summary,
        display_detail=display_detail,
    )
    _pending[approval_id] = req
    logger.info("Created approval request %s for tool %s", approval_id, tool_name)
    return req


async def wait_for_approval(req: ApprovalRequest, timeout: float = 300.0) -> bool:
    """
    Block until the user approves/rejects, or timeout (5 min default).
    Returns True if approved, False if rejected or timed out.
    """
    try:
        await asyncio.wait_for(req.event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        req.approved = False
        req.reject_reason = "Timed out waiting for user approval (5 minutes)."
        logger.warning("Approval %s timed out", req.approval_id)
    finally:
        _pending.pop(req.approval_id, None)
    return req.approved is True


def _gc_expired():
    """Remove stale entries."""
    now = time.time()
    stale = [k for k, v in _pending.items() if now - v.created_at > _EXPIRY_SECONDS]
    for k in stale:
        entry = _pending.pop(k, None)
        if entry and not entry.event.is_set():
            entry.approved = False
            entry.reject_reason = "Expired"
            entry.event.set()


# ---------------------------------------------------------------------------
# REST endpoint
# ---------------------------------------------------------------------------


class ApprovalDecision(BaseModel):
    approval_id: str
    approved: bool
    reject_reason: Optional[str] = None


@router.post("")
async def submit_approval(body: ApprovalDecision):
    """
    Called by the frontend when the user approves or rejects a tool call.
    """
    req = _pending.get(body.approval_id)
    if not req:
        raise HTTPException(
            status_code=404,
            detail=f"Approval request '{body.approval_id}' not found or already resolved.",
        )

    req.approved = body.approved
    req.reject_reason = body.reject_reason
    req.event.set()  # unblock the chat loop

    action = "approved" if body.approved else "rejected"
    logger.info("Approval %s %s by user", body.approval_id, action)
    return {"status": action, "approval_id": body.approval_id}
