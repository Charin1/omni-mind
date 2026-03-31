from typing import List, Dict, Any

class ToolConverter:
    @staticmethod
    def to_openai(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert MCP tools to OpenAI tool format."""
        openai_tools = []
        for t in tools:
            openai_tools.append({
                "type": "function",
                "function": {
                    "name": f"{t['server']}__{t['name']}",
                    "description": t['description'],
                    "parameters": t['input_schema']
                }
            })
        return openai_tools

    @staticmethod
    def to_anthropic(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert MCP tools to Anthropic tool format."""
        return [{
            "name": f"{t['server']}__{t['name']}",
            "description": t['description'],
            "input_schema": t['input_schema']
        } for t in tools]

    @staticmethod
    def to_google(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert MCP tools to Google Gemini tool format."""
        # Google uses function_declarations
        return [{
            "name": f"{t['server']}__{t['name']}",
            "description": t['description'],
            "parameters": t['input_schema']
        } for t in tools]
