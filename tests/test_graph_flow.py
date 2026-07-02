from __future__ import annotations

import shutil
from pathlib import Path

from typer.testing import CliRunner

from novel_agent.cli import app
from novel_agent.graph.workflow import run_mock_flow


def copy_example_project(tmp_path: Path) -> Path:
    project_dir = tmp_path / "example_novel"
    shutil.copytree(Path("projects/example_novel"), project_dir)
    return project_dir


def test_run_mock_flow_persists_outputs(tmp_path: Path) -> None:
    project_dir = copy_example_project(tmp_path)

    result = run_mock_flow(project_dir, chapter_id="ch099")

    assert result["revision_round"] == 1
    assert result["needs_human_review"] is False
    assert (project_dir / ".agent" / "checkpoints").exists()
    # draft mode: main file may be .draft.md
    draft_or_main = (project_dir / "chapters" / "ch099.draft.md").exists() or (project_dir / "chapters" / "ch099.md").exists()
    assert draft_or_main
    assert (project_dir / "reviews" / "ch099.review.round1.json").exists()
    assert (project_dir / "reviews" / "ch099.revision_plan.round1.md").exists()
    assert (project_dir / "exports" / "mock-flow.md").exists()
    assert "ch099" in (project_dir / "memory" / "summaries.jsonl").read_text(encoding="utf-8")
    # cover draft + checkpoint + suggestions
    assert (project_dir / "chapters" / "ch099.draft.md").exists() or (project_dir / "chapters" / "ch099.md").exists()
    assert (project_dir / ".agent" / "checkpoints").exists()
    assert isinstance(result.get("suggestions"), list)


def test_cli_mock_flow(monkeypatch, tmp_path: Path) -> None:
    project_dir = copy_example_project(tmp_path)
    monkeypatch.setenv("NOVEL_AGENT_PROJECT_DIR", str(project_dir))
    monkeypatch.setenv("NOVEL_AGENT_PROVIDER", "mock")
    monkeypatch.setenv("NOVEL_AGENT_MODEL", "mock-model")

    result = CliRunner().invoke(app, ["test", "mock-flow", "--chapter", "ch098"])

    assert result.exit_code == 0
    assert "[OK] Loaded project" in result.output
    assert "[OK] Built context" in result.output
    assert "[OK] Ran critique" in result.output
    assert "[OK] Revised draft" in result.output
    assert "[OK] Updated memory" in result.output
    draft_or_main = (project_dir / "chapters" / "ch098.draft.md").exists() or (project_dir / "chapters" / "ch098.md").exists()
    assert draft_or_main
