from __future__ import annotations

import shutil
from pathlib import Path

from typer.testing import CliRunner

from novel_agent.cli import app


def copy_example_project(tmp_path: Path) -> Path:
    project_dir = tmp_path / "example_novel"
    shutil.copytree(Path("projects/example_novel"), project_dir)
    return project_dir


def set_mock_env(monkeypatch, project_dir: Path) -> None:
    monkeypatch.setenv("NOVEL_AGENT_PROJECT_DIR", str(project_dir))
    monkeypatch.setenv("NOVEL_AGENT_PROVIDER", "mock")
    monkeypatch.setenv("NOVEL_AGENT_MODEL", "mock-model")


def test_init_project(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(app, ["init", "new_novel"])

    assert result.exit_code == 0
    assert (tmp_path / "projects" / "new_novel" / "project.yaml").exists()


def test_idea_outline_review_revise_export(monkeypatch, tmp_path: Path) -> None:
    project_dir = copy_example_project(tmp_path)
    set_mock_env(monkeypatch, project_dir)

    assert CliRunner().invoke(app, ["idea", "少年发现城市地下有灵脉", "--mock"]).exit_code == 0
    assert CliRunner().invoke(app, ["outline", "generate", "--mock"]).exit_code == 0
    assert CliRunner().invoke(app, ["chapter", "review", "ch993"]).exit_code == 0
    assert CliRunner().invoke(app, ["chapter", "revise", "ch993"]).exit_code == 0
    assert CliRunner().invoke(app, ["export", "markdown"]).exit_code == 0
    assert (project_dir / "outline" / "idea.md").exists()
    assert (project_dir / "outline" / "generated_outline.md").exists()
    assert (project_dir / "chapters" / "ch993.revised.md").exists()
    assert (project_dir / "exports" / "novel_export.md").exists()


def test_workspace_state_removes_repeated_project_env(monkeypatch, tmp_path: Path) -> None:
    project_dir = copy_example_project(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("NOVEL_AGENT_PROVIDER", "mock")
    monkeypatch.setenv("NOVEL_AGENT_MODEL", "mock-model")
    monkeypatch.delenv("NOVEL_AGENT_PROJECT_DIR", raising=False)

    runner = CliRunner()
    use_result = runner.invoke(app, ["workspace", "use", str(project_dir)])
    idea_result = runner.invoke(app, ["idea", "少年发现城市地下有灵脉", "--mock"])

    assert use_result.exit_code == 0
    assert idea_result.exit_code == 0
    assert "[warning] 当前使用 Mock 模型" in idea_result.output
    assert (project_dir / "outline" / "idea.md").exists()
