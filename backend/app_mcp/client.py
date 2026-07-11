import asyncio
import logging
from contextlib import AsyncExitStack
from typing import List, Dict, Any, Optional

import httpx

from app_mcp import oauth

logger = logging.getLogger("uvicorn.error")

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.client.streamable_http import streamablehttp_client
    from mcp.client.sse import sse_client
except ImportError:
    ClientSession = Any
    StdioServerParameters = Any
    stdio_client = None
    streamablehttp_client = None
    sse_client = None

HTTP_TRANSPORTS = {"http", "streamable_http", "streamable-http"}
SSE_TRANSPORTS = {"sse"}


def _describe_error(e: BaseException) -> str:
    """Unwrap a (possibly nested) exception group to the first non-cancellation cause.

    anyio task groups bundle a failing request together with sibling
    CancelledErrors into a BaseExceptionGroup, whose default str() ("unhandled
    errors in a TaskGroup (N sub-exceptions)") hides the actual cause (e.g. a
    401 from the server). Surface the real message instead.
    """
    if isinstance(e, BaseExceptionGroup):
        for sub in e.exceptions:
            if isinstance(sub, asyncio.CancelledError):
                continue
            return _describe_error(sub)
        return str(e)
    return str(e)


async def _probe_http(url: str, headers: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Best-effort preflight check for a clear error before the full MCP
    handshake, which on failure raises through anyio task-group cleanup and
    can surface as an opaque 'cancel scope' message instead of the real cause
    (most commonly a 401/403 because the server needs authorization).

    Returns None if the caller should proceed to the real MCP session
    handshake, or a dict {"reason": str, "requires_oauth": bool} otherwise.
    `requires_oauth` is set when the server challenges with a WWW-Authenticate
    header pointing at OAuth protected-resource metadata (RFC 9728) - i.e. it
    needs the browser-redirect authorization flow, not a static token.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                url,
                headers={
                    **headers,
                    "Accept": "application/json, text/event-stream",
                    "Content-Type": "application/json",
                },
                json={"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}},
            )
    except httpx.HTTPError as e:
        return {"reason": f"Could not reach '{url}': {e}", "requires_oauth": False}

    if resp.status_code in (401, 403):
        www_auth = resp.headers.get("www-authenticate", "")
        if oauth.parse_resource_metadata_url(www_auth):
            return {
                "reason": "This server requires signing in via OAuth. Click 'Authorize' to continue.",
                "requires_oauth": True,
            }
        return {
            "reason": (
                f"Server returned HTTP {resp.status_code} ({resp.reason_phrase}). "
                "This MCP server requires an authorization token - add one in the "
                "'Authorization Token' field."
            ),
            "requires_oauth": False,
        }
    if resp.status_code == 404:
        return {"reason": f"Server returned HTTP 404 Not Found. Double-check the URL: {url}", "requires_oauth": False}
    if resp.status_code >= 500:
        return {"reason": f"Server returned HTTP {resp.status_code} ({resp.reason_phrase}).", "requires_oauth": False}
    return None


class MCPClientHub:
    def __init__(self):
        self.sessions: Dict[str, ClientSession] = {}
        self.server_configs: Dict[str, Dict[str, Any]] = {}
        # Each connected server owns an AsyncExitStack that keeps its
        # transport (subprocess / HTTP stream) and ClientSession alive
        # for as long as the hub holds a reference to it.
        self._exit_stacks: Dict[str, AsyncExitStack] = {}

    async def disconnect(self, name: str):
        """Tear down an existing connection for `name`, if any."""
        self.sessions.pop(name, None)
        stack = self._exit_stacks.pop(name, None)
        if stack is not None:
            try:
                await stack.aclose()
            except BaseException:
                # Best-effort cleanup; a misbehaving server shouldn't block reconnects.
                pass

    async def connect_stdio_server(
        self,
        name: str,
        command: str,
        args: List[str],
        config: Optional[Dict[str, Any]] = None,
    ):
        """Connect to an MCP server via stdio (local subprocess)."""
        if stdio_client is None:
            raise RuntimeError("MCP support is not installed")

        env_vars = config.get("env") if config else None
        params = StdioServerParameters(command=command, args=args, env=env_vars)

        await self.disconnect(name)
        stack = AsyncExitStack()
        try:
            read, write = await stack.enter_async_context(stdio_client(params))
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
        except BaseException:
            # anyio task groups wrap a failing request together with the
            # sibling CancelledError as a BaseExceptionGroup, which is a
            # BaseException, not an Exception - a plain `except Exception`
            # here would miss it entirely and let it escape uncaught into
            # the caller (and, over the FastAPI route, into unrelated
            # request-scoped resources like the DB session).
            try:
                await stack.aclose()
            except BaseException:
                pass
            raise

        self._exit_stacks[name] = stack
        self.sessions[name] = session
        self.server_configs[name] = config or {}
        return session

    async def connect_http_server(
        self,
        name: str,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        """Connect to a remote MCP server over Streamable HTTP."""
        if streamablehttp_client is None:
            raise RuntimeError("MCP support is not installed")

        await self.disconnect(name)
        stack = AsyncExitStack()
        try:
            read, write, _get_session_id = await stack.enter_async_context(
                streamablehttp_client(url, headers=headers or {})
            )
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
        except BaseException:
            # anyio task groups wrap a failing request together with the
            # sibling CancelledError as a BaseExceptionGroup, which is a
            # BaseException, not an Exception - a plain `except Exception`
            # here would miss it entirely and let it escape uncaught into
            # the caller (and, over the FastAPI route, into unrelated
            # request-scoped resources like the DB session).
            try:
                await stack.aclose()
            except BaseException:
                pass
            raise

        self._exit_stacks[name] = stack
        self.sessions[name] = session
        self.server_configs[name] = config or {}
        return session

    async def connect_sse_server(
        self,
        name: str,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        """Connect to a remote MCP server over the legacy HTTP+SSE transport."""
        if sse_client is None:
            raise RuntimeError("MCP support is not installed")

        await self.disconnect(name)
        stack = AsyncExitStack()
        try:
            read, write = await stack.enter_async_context(
                sse_client(url, headers=headers or {})
            )
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
        except BaseException:
            # anyio task groups wrap a failing request together with the
            # sibling CancelledError as a BaseExceptionGroup, which is a
            # BaseException, not an Exception - a plain `except Exception`
            # here would miss it entirely and let it escape uncaught into
            # the caller (and, over the FastAPI route, into unrelated
            # request-scoped resources like the DB session).
            try:
                await stack.aclose()
            except BaseException:
                pass
            raise

        self._exit_stacks[name] = stack
        self.sessions[name] = session
        self.server_configs[name] = config or {}
        return session

    @staticmethod
    def _resolve_headers(config: Dict[str, Any]) -> Dict[str, str]:
        headers = dict(config.get("headers") or {})
        token = config.get("authorization_token") or config.get("token")
        if not token:
            token = (config.get("oauth") or {}).get("access_token")
        if token:
            headers.setdefault("Authorization", f"Bearer {token}")
        return headers

    async def connect_from_config(
        self,
        name: str,
        transport: str,
        config: Dict[str, Any],
    ) -> Dict[str, Any]:
        self.server_configs[name] = config
        transport = (transport or "").lower()

        try:
            if transport == "stdio":
                if not config.get("command"):
                    return {"connected": False, "transport": transport, "reason": "Missing 'command' for stdio server."}
                session = await self.connect_stdio_server(
                    name=name,
                    command=config["command"],
                    args=config.get("args", []),
                    config=config,
                )
                return {"connected": True, "transport": "stdio", "session": bool(session)}

            if transport in HTTP_TRANSPORTS:
                if not config.get("url"):
                    return {"connected": False, "transport": transport, "reason": "Missing 'url' for HTTP server."}
                headers = self._resolve_headers(config)
                probe = await _probe_http(config["url"], headers)
                if probe:
                    return {"connected": False, "transport": transport, **probe}
                session = await self.connect_http_server(
                    name=name,
                    url=config["url"],
                    headers=headers,
                    config=config,
                )
                return {"connected": True, "transport": transport, "session": bool(session)}

            if transport in SSE_TRANSPORTS:
                if not config.get("url"):
                    return {"connected": False, "transport": transport, "reason": "Missing 'url' for SSE server."}
                headers = self._resolve_headers(config)
                probe = await _probe_http(config["url"], headers)
                if probe:
                    return {"connected": False, "transport": transport, **probe}
                session = await self.connect_sse_server(
                    name=name,
                    url=config["url"],
                    headers=headers,
                    config=config,
                )
                return {"connected": True, "transport": transport, "session": bool(session)}
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as e:
            logger.exception("MCP connect failed for server '%s' (%s)", name, transport)
            return {"connected": False, "transport": transport, "reason": _describe_error(e)}

        return {
            "connected": False,
            "transport": transport,
            "reason": f"Unsupported transport '{transport}'. Use 'stdio', 'http', or 'sse'.",
        }

    async def list_tools(self) -> List[Dict[str, Any]]:
        """List all tools available across all connected MCP servers."""
        all_tools = []
        for name, session in self.sessions.items():
            try:
                result = await session.list_tools()
                for tool in result.tools:
                    all_tools.append({
                        "server": name,
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.inputSchema
                    })
            except Exception:
                continue
        return all_tools

    async def call_tool(self, server_name: str, tool_name: str, arguments: Dict[str, Any]) -> Any:
        """Call a specific tool on a specific server."""
        session = self.sessions.get(server_name)
        if not session:
            raise ValueError(f"Server {server_name} not connected")

        return await session.call_tool(tool_name, arguments)

# Global hub instance
mcp_hub = MCPClientHub()
