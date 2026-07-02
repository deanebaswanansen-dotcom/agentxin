from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, Field


class ChapterSummaryUpdate(BaseModel):
    chapter_id: str
    summary: str
    next_hook: str = ""
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
