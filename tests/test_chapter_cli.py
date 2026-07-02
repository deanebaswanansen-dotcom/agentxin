from __future__ import annotations

import shutil
from pathlib import Path

from typer.testing import CliRunner

from novel_agent.cli import app


def copy_example_project(tmp_path: Path) -> Path:
    project_dir = tmp_path / "example_novel"
    shutil.copytree(Path("projects/example_novel"), project_dir)
    return project_dir


def test_chapter_write_uses_graph_and_mock_provider(monkeypatch, tmp_path: Path) -> None:
    project_dir = copy_example_project(tmp_path)
    monkeypatch.setenv("NOVEL_AGENT_PROJECT_DIR", str(project_dir))
    monkeypatch.setenv("NOVEL_AGENT_PROVIDER", "mock")
    monkeypatch.setenv("NOVEL_AGENT_MODEL", "mock-model")

    result = CliRunner().invoke(app, ["chapter", "write", "ch075", "--task", "写测试章", "--mock"])

    assert result.exit_code == 0
    assert "[OK] Wrote draft" in result.output
    assert "[OK] Updated memory" in result.output
    draft_ok = (project_dir / "chapters" / "ch075.draft.md").exists() or (project_dir / "chapters" / "ch075.md").exists()
    assert draft_ok


def test_chapter_write_refuses_overwrite_without_flag(monkeypatch, tmp_path: Path) -> None:
    project_dir = copy_example_project(tmp_path)
    chapter_path = project_dir / "chapters" / "ch074.md"
    chapter_path.parent.mkdir(parents=True, exist_ok=True)
    chapter_path.write_text("exists", encoding="utf-8")
    monkeypatch.setenv("NOVEL_AGENT_PROJECT_DIR", str(project_dir))
    monkeypatch.setenv("NOVEL_AGENT_PROVIDER", "mock")
    monkeypatch.setenv("NOVEL_AGENT_MODEL", "mock-model")

    result = CliRunner().invoke(app, ["chapter", "write", "ch074", "--mock"])

    assert result.exit_code == 2
    assert "File exists" in result.output
