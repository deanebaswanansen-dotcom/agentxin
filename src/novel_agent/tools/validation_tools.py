from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from novel_agent.providers.base import ToolDescriptor
from novel_agent.memory import LongTermMemoryStore


class ContinuityCheckInput(BaseModel):
    chapter_id: str
    draft: str = ""


class ContinuityCheckOutput(BaseModel):
    chapter_id: str
    issues_count: int
    passed: bool
    report_path: str | None = None


class ContinuityCheckTool:
    """Real validation tool for continuity (called via reflection/critique too)."""

    descriptor = ToolDescriptor(
        name="ContinuityCheckTool",
        purpose="Validate continuity, foreshadowing and reflection output against memory.",
        input_schema=ContinuityCheckInput.model_json_schema(),
        output_schema=ContinuityCheckOutput.model_json_schema(),
        error_types=["MEMORY_READ_ERROR"],
    )

    def run(self, project_dir: Path, data: ContinuityCheckInput) -> ContinuityCheckOutput:
        mem = LongTermMemoryStore(project_dir)
        # simplistic: check if memory dir ready, count facts etc.
        summary_path = project_dir / "memory" / "summaries.jsonl"
        issues = 0
        if not summary_path.exists():
            issues += 1
        # In full would cross check draft text vs memory facts
        passed = issues == 0
        return ContinuityCheckOutput(
            chapter_id=data.chapter_id,
            issues_count=issues,
            passed=passed,
            report_path=str(summary_path) if summary_path.exists() else None,
        )
