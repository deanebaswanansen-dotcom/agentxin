from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field

from novel_agent.memory.chapter_summary import ChapterSummaryUpdate


class MemoryUpdate(BaseModel):
    chapter_id: str
    summary: str
    new_facts: list[str] = Field(default_factory=list)
    character_updates: dict[str, str] = Field(default_factory=dict)
    foreshadowing_updates: list[dict[str, str]] = Field(default_factory=list)
    timeline_events: list[str] = Field(default_factory=list)
    next_hook: str = ""


class LongTermMemoryStore:
    def __init__(self, project_dir: Path):
        self.project_dir = project_dir
        self.memory_dir = project_dir / "memory"
        self.memory_dir.mkdir(parents=True, exist_ok=True)

    def apply_update(self, update: MemoryUpdate) -> dict[str, str]:
        return {
            "summary": str(self._append_summary(update)),
            "continuity": str(self._update_continuity(update)),
            "character_arcs": str(self._update_character_arcs(update)),
            "foreshadowing": str(self._update_foreshadowing(update)),
            "timeline": str(self._update_timeline(update)),
        }

    def _append_summary(self, update: MemoryUpdate) -> Path:
        path = self.memory_dir / "summaries.jsonl"
        row = ChapterSummaryUpdate(
            chapter_id=update.chapter_id,
            summary=update.summary,
            next_hook=update.next_hook,
        )
        previous = path.read_text(encoding="utf-8") if path.exists() else ""
        path.write_text(previous + row.model_dump_json() + "\n", encoding="utf-8")
        return path

    def _update_continuity(self, update: MemoryUpdate) -> Path:
        path = self.memory_dir / "continuity.json"
        payload = self._read_json(path, {"facts": []})
        facts = payload.setdefault("facts", [])
        existing = {item.get("text") for item in facts if isinstance(item, dict)}
        for index, fact in enumerate(update.new_facts, start=len(facts) + 1):
            if fact not in existing:
                facts.append({"id": f"fact-{index:03d}", "text": fact, "source": update.chapter_id})
        self._write_json(path, payload)
        return path

    def _update_character_arcs(self, update: MemoryUpdate) -> Path:
        path = self.memory_dir / "character_arcs.json"
        payload = self._read_json(path, {"characters": {}})
        characters = payload.setdefault("characters", {})
        for name, change in update.character_updates.items():
            record = characters.setdefault(name, {"current_stage": "", "change_log": []})
            record.setdefault("change_log", []).append(change)
        self._write_json(path, payload)
        return path

    def _update_foreshadowing(self, update: MemoryUpdate) -> Path:
        path = self.memory_dir / "foreshadowing.json"
        payload = self._read_json(path, {"items": []})
        items = payload.setdefault("items", [])
        by_id = {item.get("id"): item for item in items if isinstance(item, dict)}
        for item in update.foreshadowing_updates:
            item_id = item.get("id") or f"fs-{len(items) + 1:03d}"
            record = by_id.get(item_id)
            if record is None:
                record = {"id": item_id, "introduced_in": update.chapter_id}
                items.append(record)
                by_id[item_id] = record
            record.update({key: value for key, value in item.items() if value})
        self._write_json(path, payload)
        return path

    def _update_timeline(self, update: MemoryUpdate) -> Path:
        path = self.memory_dir / "timeline.json"
        payload = self._read_json(path, {"events": []})
        events = payload.setdefault("events", [])
        for event in update.timeline_events:
            events.append({"chapter_id": update.chapter_id, "event": event})
        self._write_json(path, payload)
        return path

    def _read_json(self, path: Path, default: dict) -> dict:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_json(self, path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
