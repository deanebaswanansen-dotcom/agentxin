from __future__ import annotations

from pathlib import Path
from typing import Any

from novel_agent.mcp.server import NovelMCPServer


class NovelMCPClient:
    def __init__(self, project_dir: Path):
        self.server = NovelMCPServer(project_dir)

    def list_tools(self) -> list[str]:
        return [tool.name for tool in self.server.manifest().tools]

    def call_tool(self, name: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self.server.call_tool(name, payload)
