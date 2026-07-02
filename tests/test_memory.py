from __future__ import annotations

import json
import shutil
from pathlib import Path

from typer.testing import CliRunner

from novel_agent.cli import app
from novel_agent.memory import LongTermMemoryStore, MemoryUpdate


def copy_example_project(tmp_path: Path) -> Path:
    project_dir = tmp_path / "example_novel"
    shutil.copytree(Path("projects/example_novel"), project_dir)
    return project_dir


def test_long_term_memory_store_updates_all_files(tmp_path: Path) -> None:
    project_dir = copy_example_project(tmp_path)
    update = MemoryUpdate(
        chapter_id="ch077",
        summary="测试章节摘要",
        new_facts=["测试事实"],
        character_updates={"林澈": "测试人物变化"},
        foreshadowing_updates=[{"id": "fs-test", "status": "active", "text": "测试伏笔"}],
        timeline_events=["测试时间线事件"],
        next_hook="测试下章钩子",
    )

    LongTermMemoryStore(project_dir).apply_update(update)

    assert "ch077" in (project_dir / "memory" / "summaries.jsonl").read_text(encoding="utf-8")
    assert "测试事实" in (project_dir / "memory" / "continuity.json").read_text(encoding="utf-8")
    assert "测试人物变化" in (project_dir / "memory" / "character_arcs.json").read_text(encoding="utf-8")
    assert "fs-test" in (project_dir / "memory" / "foreshadowing.json").read_text(encoding="utf-8")
    timeline = json.loads((project_dir / "memory" / "timeline.json").read_text(encoding="utf-8"))
    assert timeline["events"][-1]["event"] == "测试时间线事件"


def test_cli_memory_update(monkeypatch, tmp_path: Path) -> None:
    project_dir = copy_example_project(tmp_path)
    monkeypatch.setenv("NOVEL_AGENT_PROJECT_DIR", str(project_dir))
    monkeypatch.setenv("NOVEL_AGENT_PROVIDER", "mock")
    monkeypatch.setenv("NOVEL_AGENT_MODEL", "mock-model")

    result = CliRunner().invoke(app, ["memory", "update", "ch076", "--summary", "CLI 摘要"])

    assert result.exit_code == 0
    assert "[OK] summary" in result.output
    assert "CLI 摘要" in (project_dir / "memory" / "summaries.jsonl").read_text(encoding="utf-8")
