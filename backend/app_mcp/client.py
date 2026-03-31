import asyncio
from typing import List, Dict, Any, Optional

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
except ImportError:
    ClientSession = Any
    StdioServerParameters = Any
    stdio_client = None

class MCPClientHub:
    def __init__(self):
        self.sessions: Dict[str, ClientSession] = {}
        self.server_params: Dict[str, StdioServerParameters] = {}
        self.server_configs: Dict[str, Dict[str, Any]] = {}

    async def connect_stdio_server(
        self,
        name: str,
        command: str,
        args: List[str],
        config: Optional[Dict[str, Any]] = None,
    ):
        """Connect to an MCP server via stdio."""
        if stdio_client is None:
            raise RuntimeError("MCP support is not installed")

        params = StdioServerParameters(command=command, args=args)
        self.server_params[name] = params
        self.server_configs[name] = config or {}
        
        # In a real app, you might want to manage lifecycle better
        # This is a simplified async connection
        transport = await stdio_client(params)
        read, write = transport
        session = ClientSession(read, write)
        await session.initialize()
        self.sessions[name] = session
        return session

    async def connect_from_config(
        self,
        name: str,
        transport: str,
        config: Dict[str, Any],
    ) -> Dict[str, Any]:
        self.server_configs[name] = config

        if transport == "stdio":
            session = await self.connect_stdio_server(
                name=name,
                command=config["command"],
                args=config.get("args", []),
                config=config,
            )
            return {"connected": True, "transport": "stdio", "session": bool(session)}

        return {
            "connected": False,
            "transport": transport,
            "reason": "Stored configuration only. Install MCP transport support to activate this server.",
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
