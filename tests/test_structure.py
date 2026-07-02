from __future__ import annotations

from pathlib import Path

from novel_agent.prompts import SYSTEM_PROMPT
from novel_agent.tools.file_tools import FileReadInput, FileReadTool, FileWriteInput, FileWriteTool


def test_prompt_tool_evaluation_structure_exists() -> None:
    base = Path("src/novel_agent")
    for relative in [
        "prompts/system.py",
        "prompts/planner.py",
        "prompts/writer.py",
        "prompts/critic.py",
        "prompts/reviser.py",
        "tools/file_tools.py",
        "tools/project_tools.py",
        "evaluation/rubrics.py",
        "evaluation/scoring.py",
    ]:
        assert (base / relative).exists()
    assert "小说写作 Agent" in SYSTEM_PROMPT


def test_file_tools_are_project_scoped(tmp_path: Path) -> None:
    writer = FileWriteTool()
    reader = FileReadTool()

    output = writer.run(tmp_path, FileWriteInput(path="notes/a.md", content="ok"))
    assert output.bytes_written == 2
    assert reader.run(tmp_path, FileReadInput(path="notes/a.md")).content == "ok"
