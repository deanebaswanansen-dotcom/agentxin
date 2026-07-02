from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from novel_agent.mcp import NovelMCPClient, PathSecurityError, build_manifest, ensure_project_path


def copy_example_project(tmp_path: Path) -> Path:
    project_dir = tmp_path / "example_novel"
    shutil.copytree(Path("projects/example_novel"), project_dir)
    return project_dir


def test_mcp_manifest_contains_required_surface() -> None:
    manifest = build_manifest()

    assert "novel.project.load" in [tool.name for tool in manifest.tools]
    assert "novel.memory.update" in [tool.name for tool in manifest.tools]
    assert "novel://project/bible" in [resource.uri for resource in manifest.resources]
    assert "novel.write_chapter" in [prompt.name for prompt in manifest.prompts]


def test_mcp_path_security_rejects_escape(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    project_dir.mkdir()

    with pytest.raises(PathSecurityError):
        ensure_project_path(project_dir, "../../.env")


def test_mcp_client_project_load(tmp_path: Path) -> None:
    project_dir = copy_example_project(tmp_path)
    client = NovelMCPClient(project_dir)

    assert "novel.context.build" in client.list_tools()
    result = client.call_tool("novel.project.load", {})
    assert "bible/premise.md" in result["loaded_files"]
