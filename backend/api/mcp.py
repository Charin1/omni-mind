import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app_mcp import oauth as mcp_oauth
from app_mcp.client import mcp_hub
from observability import metrics as obs_metrics
from db.database import get_db
from db.models import MCPServer

logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


class MCPServerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    transport: str
    config_json: Optional[Any] = None
    is_active: bool
    connected: bool = False


class MCPServerCreate(BaseModel):
    id: str
    name: str
    transport: str
    config_json: Dict[str, Any]
    is_active: bool = True


@router.get("/servers", response_model=List[MCPServerResponse])
async def list_servers(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MCPServer).order_by(MCPServer.name.asc()))
    servers = result.scalars().all()
    return [
        MCPServerResponse(
            id=s.id,
            name=s.name,
            transport=s.transport,
            config_json=s.config_json,
            is_active=s.is_active,
            connected=s.name in mcp_hub.sessions,
        )
        for s in servers
    ]


@router.post("/servers", response_model=MCPServerResponse)
async def create_server(data: MCPServerCreate, db: AsyncSession = Depends(get_db)):
    existing_id = await db.get(MCPServer, data.id)
    if existing_id:
        raise HTTPException(status_code=400, detail="MCP server already exists")

    existing_name = await db.execute(select(MCPServer).where(MCPServer.name == data.name))
    if existing_name.scalars().first():
        raise HTTPException(status_code=400, detail=f"MCP server named '{data.name}' already exists")

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

    config = dict(server.config_json or {})
    oauth_info = config.get("oauth")
    if oauth_info and oauth_info.get("expires_at") and oauth_info["expires_at"] < time.time() + 30:
        try:
            config["oauth"] = await mcp_oauth.refresh_access_token(oauth_info)
            server.config_json = config
            await db.commit()
        except Exception:
            logger.warning("OAuth token refresh failed for MCP server '%s'; connecting with existing token", server.name)

    result = await mcp_hub.connect_from_config(
        name=server.name,
        transport=server.transport,
        config=config,
    )
    obs_metrics.record_mcp_connect(server.transport, "ok" if result.get("connected") else "error")
    return {"server": server.name, **result}


@router.post("/servers/{server_id}/oauth/start")
async def start_mcp_oauth(server_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    server = await db.get(MCPServer, server_id)
    if not server:
        raise HTTPException(status_code=404, detail="MCP server not found")

    config = server.config_json or {}
    if not config.get("url"):
        raise HTTPException(status_code=400, detail="Server has no URL configured")

    redirect_uri = f"{str(request.base_url).rstrip('/')}/api/mcp/oauth/callback"
    try:
        authorization_url = await mcp_oauth.start_authorization(
            server_id=server.id,
            mcp_url=config["url"],
            redirect_uri=redirect_uri,
            existing_oauth=config.get("oauth"),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"authorization_url": authorization_url}


@router.get("/oauth/callback")
async def mcp_oauth_callback(
    code: str = "",
    state: str = "",
    error: str = "",
    db: AsyncSession = Depends(get_db),
):
    if error:
        return HTMLResponse(
            f"<html><body><h3>Authorization failed: {error}</h3><p>You can close this window.</p></body></html>",
            status_code=400,
        )
    if not code or not state:
        return HTMLResponse(
            "<html><body><h3>Missing authorization code.</h3><p>You can close this window.</p></body></html>",
            status_code=400,
        )

    try:
        result = await mcp_oauth.complete_authorization(code=code, state=state)
    except Exception as e:
        return HTMLResponse(
            f"<html><body><h3>Authorization failed: {e}</h3><p>You can close this window.</p></body></html>",
            status_code=400,
        )

    server = await db.get(MCPServer, result["server_id"])
    if server:
        config = dict(server.config_json or {})
        config["oauth"] = result["oauth"]
        server.config_json = config
        await db.commit()

    return HTMLResponse(
        "<html><body><script>window.close();</script>"
        "<h3>Authorization complete.</h3><p>You can close this window.</p></body></html>"
    )


@router.delete("/servers/{server_id}")
async def delete_server(server_id: str, db: AsyncSession = Depends(get_db)):
    server = await db.get(MCPServer, server_id)
    if not server:
        raise HTTPException(status_code=404, detail="MCP server not found")

    await mcp_hub.disconnect(server.name)
    await db.delete(server)
    await db.commit()
    return {"deleted": server_id}


@router.get("/tools")
async def list_mcp_tools():
    return await mcp_hub.list_tools()
