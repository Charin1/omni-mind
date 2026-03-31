from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app_mcp.client import mcp_hub
from db.database import get_db
from db.models import MCPServer

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


class MCPServerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    transport: str
    config_json: Optional[Any] = None
    is_active: bool


class MCPServerCreate(BaseModel):
    id: str
    name: str
    transport: str
    config_json: Dict[str, Any]
    is_active: bool = True


@router.get("/servers", response_model=List[MCPServerResponse])
async def list_servers(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MCPServer).order_by(MCPServer.name.asc()))
    return result.scalars().all()


@router.post("/servers", response_model=MCPServerResponse)
async def create_server(data: MCPServerCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.get(MCPServer, data.id)
    if existing:
        raise HTTPException(status_code=400, detail="MCP server already exists")

    server = MCPServer(
        id=data.id,
        name=data.name,
        transport=data.transport,
        config_json=data.config_json,
        is_active=data.is_active,
    )
    db.add(server)
    await db.commit()
    await db.refresh(server)
    return server


@router.post("/servers/{server_id}/connect")
async def connect_server(server_id: str, db: AsyncSession = Depends(get_db)):
    server = await db.get(MCPServer, server_id)
    if not server:
        raise HTTPException(status_code=404, detail="MCP server not found")

    result = await mcp_hub.connect_from_config(
        name=server.name,
        transport=server.transport,
        config=server.config_json or {},
    )
    return {"server": server.name, **result}


@router.get("/tools")
async def list_mcp_tools():
    return await mcp_hub.list_tools()
