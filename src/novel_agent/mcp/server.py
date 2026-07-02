from __future__ import annotations

from pathlib import Path
from typing import Any

from novel_agent.context.context_builder import ContextBuilder
from novel_agent.context.project_loader import ProjectLoader
from novel_agent.mcp.manifest import NovelMCPManifest, build_manifest
from novel_agent.mcp.tools import ensure_project_path
from novel_agent.memory import LongTermMemoryStore, MemoryUpdate


class NovelMCPServer:
    def __init__(self, project_dir: Path):
        self.project_dir = project_dir

    def manifest(self) -> NovelMCPManifest:
        return build_manifest()

    def call_tool(self, name: str, payload: dict[str, Any]) -> dict[str, Any]:
        if name == "novel.project.load":
            snapshot = ProjectLoader(self.project_dir).load()
            return {"loaded_files": list(snapshot.loaded_files.keys())}
        if name == "novel.context.build":
            result = ContextBuilder(self.project_dir).build(
                chapter_id=str(payload.get("chapter_id", "ch001")),
                task=str(payload.get("task", "")),
            )
            return {"messages": [message.model_dump() for message in result.messages]}
        if name == "novel.chapter.read":
            path = ensure_project_path(self.project_dir, payload["path"])
            return {"path": str(path), "content": path.read_text(encoding="utf-8")}
        if name == "novel.memory.update":
            update = MemoryUpdate.model_validate(payload)
            return LongTermMemoryStore(self.project_dir).apply_update(update)
        raise ValueError(f"unsupported MCP tool: {name}")
