from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from novel_agent.context.project_loader import ProjectLoader, ProjectSnapshot
from novel_agent.context.token_budget import ContextItem, TokenBudgetReport, apply_budget, estimate_tokens
from novel_agent.prompts.system import SYSTEM_PROMPT
from novel_agent.providers.base import Message

class ContextBuildResult(BaseModel):
    messages: list[Message]
    loaded_files: list[str] = Field(default_factory=list)
    recent_summary_ids: list[str] = Field(default_factory=list)
    active_foreshadowing_count: int = 0
    token_budget_report: TokenBudgetReport


class ContextBuilder:
    def __init__(self, project_dir: Path, max_context_tokens: int = 32000):
        self.project_dir = project_dir
        self.max_context_tokens = max_context_tokens

    def build(self, chapter_id: str, task: str, recent_chapters: int = 12) -> ContextBuildResult:
        snapshot = ProjectLoader(self.project_dir).load(recent_chapters=recent_chapters)
        items = self._items(snapshot, chapter_id, task)
        included, report = apply_budget(items, self.max_context_tokens)
        messages = [
            Message(role="system", content=SYSTEM_PROMPT),
            *[Message(role="system", content=f"[{item.name}]\n{item.content}") for item in included],
            Message(role="user", content=f"当前章节：{chapter_id}\n当前任务：{task}"),
        ]
        return ContextBuildResult(
            messages=messages,
            loaded_files=list(snapshot.loaded_files.keys()),
            recent_summary_ids=[item.chapter_id for item in snapshot.recent_summaries],
            active_foreshadowing_count=len(snapshot.active_foreshadowing),
            token_budget_report=report,
        )

    def _items(self, snapshot: ProjectSnapshot, chapter_id: str, task: str) -> list[ContextItem]:
        # Collect full bible (all bible/*.md + required)
        bible_parts = []
        for key in sorted(k for k in snapshot.loaded_files if k.startswith("bible/")):
            bible_parts.append(f"[{key}]\n{snapshot.loaded_files[key]}")
        full_bible = "\n\n".join(bible_parts)

        contents = {
            "task": task,
            "system_prompt": SYSTEM_PROMPT,
            "chapter_plan": snapshot.loaded_files.get("outline/chapter_plan.md", ""),
            "characters": snapshot.loaded_files.get("bible/characters.md", ""),
            "full_bible": full_bible,  # now includes ALL bible files
            "style_taboos": "\n\n".join(
                [
                    snapshot.loaded_files.get("bible/style.md", ""),
                    snapshot.loaded_files.get("bible/taboos.md", ""),
                ]
            ),
            "recent_summaries": "\n".join(
                f"{item.chapter_id}: {item.summary}" for item in snapshot.recent_summaries
            ),
            "active_foreshadowing": "\n".join(
                f"{item.id}: {item.text}" for item in snapshot.active_foreshadowing
            ),
            "continuity_facts": "\n".join(
                f"- {item.text}" for item in snapshot.continuity_facts[-40:]
            ),
            "character_arcs": "\n".join(
                f"- {arc.name}: {arc.current_stage or arc.change_log[-1] if arc.change_log else '状态未记录'}"
                for arc in snapshot.character_arcs
            ),
            "world": snapshot.loaded_files.get("bible/world.md", ""),
            "premise_canon": "\n\n".join(
                [
                    snapshot.loaded_files.get("bible/premise.md", ""),
                    snapshot.loaded_files.get("bible/canon.md", ""),
                ]
            ),
            "chapter_id": chapter_id,
        }
        priorities = {
            "task": 1,
            "system_prompt": 2,
            "chapter_plan": 3,
            "characters": 4,
            "full_bible": 5,  # high after plan
            "style_taboos": 6,
            "recent_summaries": 7,
            "active_foreshadowing": 8,
            "continuity_facts": 8,
            "character_arcs": 9,
            "world": 10,
            "premise_canon": 11,
            "chapter_id": 12,
        }
        return [
            ContextItem(
                name=name,
                content=content,
                priority=priorities[name],
                tokens=estimate_tokens(content),
            )
            for name, content in contents.items()
            if content.strip()
        ]
