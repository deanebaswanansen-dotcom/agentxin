from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field


class ChapterSummary(BaseModel):
    chapter_id: str
    summary: str


class ForeshadowingItem(BaseModel):
    id: str
    status: str
    text: str
    introduced_in: str | None = None


class ContinuityFact(BaseModel):
    id: str
    text: str
    source: str | None = None


class CharacterArc(BaseModel):
    name: str
    current_stage: str = ""
    change_log: list[str] = Field(default_factory=list)


class ProjectSnapshot(BaseModel):
    project_dir: Path
    loaded_files: dict[str, str] = Field(default_factory=dict)
    recent_summaries: list[ChapterSummary] = Field(default_factory=list)
    active_foreshadowing: list[ForeshadowingItem] = Field(default_factory=list)
    continuity_facts: list[ContinuityFact] = Field(default_factory=list)
    character_arcs: list[CharacterArc] = Field(default_factory=list)


class ProjectLoader:
    required_files = [
        "bible/premise.md",
        "bible/characters.md",
        "bible/world.md",
        "bible/style.md",
        "bible/taboos.md",
        "bible/canon.md",
        "outline/chapter_plan.md",
    ]

    def __init__(self, project_dir: Path):
        self.project_dir = project_dir

    def load(self, recent_chapters: int = 12) -> ProjectSnapshot:
        if not self.project_dir.exists():
            raise FileNotFoundError(f"project_dir not found: {self.project_dir}")
        loaded_files = {
            relative: self._read_text(relative)
            for relative in self.required_files
            if (self.project_dir / relative).exists()
        }
        # Support full bible: load ALL bible/*.md files dynamically (per strict spec)
        bible_dir = self.project_dir / "bible"
        if bible_dir.exists():
            for md in sorted(bible_dir.glob("*.md")):
                rel = f"bible/{md.name}"
                if rel not in loaded_files:
                    loaded_files[rel] = md.read_text(encoding="utf-8")
        return ProjectSnapshot(
            project_dir=self.project_dir,
            loaded_files=loaded_files,
            recent_summaries=self._load_recent_summaries(recent_chapters),
            active_foreshadowing=self._load_active_foreshadowing(),
            continuity_facts=self._load_continuity_facts(),
            character_arcs=self._load_character_arcs(),
        )

    def _read_text(self, relative: str) -> str:
        return (self.project_dir / relative).read_text(encoding="utf-8")

    def _load_recent_summaries(self, limit: int) -> list[ChapterSummary]:
        path = self.project_dir / "memory" / "summaries.jsonl"
        if not path.exists():
            return []
        rows: list[ChapterSummary] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            payload = json.loads(line)
            rows.append(ChapterSummary(chapter_id=payload["chapter_id"], summary=payload["summary"]))
        return rows[-limit:]

    def _load_continuity_facts(self) -> list[ContinuityFact]:
        path = self.project_dir / "memory" / "continuity.json"
        if not path.exists():
            return []
        payload = json.loads(path.read_text(encoding="utf-8"))
        facts = payload.get("facts", [])
        rows: list[ContinuityFact] = []
        for item in facts:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text", "")).strip()
            if not text:
                continue
            rows.append(
                ContinuityFact(
                    id=str(item.get("id", "")),
                    text=text,
                    source=item.get("source"),
                )
            )
        return rows

    def _load_character_arcs(self) -> list[CharacterArc]:
        path = self.project_dir / "memory" / "character_arcs.json"
        if not path.exists():
            return []
        payload = json.loads(path.read_text(encoding="utf-8"))
        characters = payload.get("characters", {})
        rows: list[CharacterArc] = []
        if not isinstance(characters, dict):
            return rows
        for name, record in characters.items():
            if not isinstance(record, dict):
                continue
            change_log = record.get("change_log", [])
            rows.append(
                CharacterArc(
                    name=str(name),
                    current_stage=str(record.get("current_stage", "")),
                    change_log=[str(x) for x in change_log if str(x).strip()],
                )
            )
        return rows

    def _load_active_foreshadowing(self) -> list[ForeshadowingItem]:
        path = self.project_dir / "memory" / "foreshadowing.json"
        if not path.exists():
            return []
        payload = json.loads(path.read_text(encoding="utf-8"))
        items = payload.get("items", [])
        return [
            ForeshadowingItem(**item)
            for item in items
            if isinstance(item, dict) and item.get("status") == "active"
        ]
