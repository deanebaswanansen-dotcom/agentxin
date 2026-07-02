from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from novel_agent.providers.base import ToolDescriptor


class StatsInput(BaseModel):
    chapter_id: str
    text: str = ""


class StatsOutput(BaseModel):
    chapter_id: str
    word_count: int
    approx_tokens: int
    pacing_score: float  # simple heuristic 0-10 based on length / para


class StatsTool:
    """Stats for word count, pacing if shared (per task req)."""

    descriptor = ToolDescriptor(
        name="StatsTool",
        purpose="Count chapter words and estimate pacing / tokens.",
        input_schema=StatsInput.model_json_schema(),
        output_schema=StatsOutput.model_json_schema(),
    )

    def run(self, project_dir: Path, data: StatsInput) -> StatsOutput:
        text = data.text or ""
        # Chinese word count approx (char based for novel)
        word_count = len([c for c in text if not c.isspace()])
        approx_tokens = max(1, word_count // 2)
        paras = max(1, text.count("\n\n") + 1)
        # naive pacing: ~2500 target, too short/long penalize
        target = 2500
        ratio = min(1.5, max(0.3, word_count / target))
        pacing = round(10 * (1 - abs(1 - ratio) * 0.6), 1)
        return StatsOutput(
            chapter_id=data.chapter_id,
            word_count=word_count,
            approx_tokens=approx_tokens,
            pacing_score=pacing,
        )
