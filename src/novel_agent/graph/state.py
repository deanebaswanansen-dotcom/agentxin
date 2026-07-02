from __future__ import annotations

from typing import TypedDict


class NovelAgentState(TypedDict, total=False):
    task_id: str
    project_dir: str
    user_request: str
    chapter_id: str | None

    system_prompt: str
    project_context: dict
    memory_context: dict
    retrieved_context: list[dict]
    token_budget_report: dict

    plan: dict | None
    draft: str | None
    critique: dict | None
    revision_plan: dict | None
    revised_draft: str | None

    tool_results: list[dict]
    errors: list[dict]
    needs_human_review: bool
    final_output_path: str | None
    revision_round: int
    provider_config: dict | None

    # Chapter blueprint & scene writing extensions (stage 1)
    blueprint: dict | None
    scenes: list[dict] | None
    scene_contents: dict | None  # { "1": "content...", ... }
    word_count_report: dict | None
    pacing_report: dict | None
    chapter_content: str | None
    reports: dict | None  # { "word_count": {...}, "pacing": {...} }

    # Active Agent fields (refactoring spec): proactive suggestions + auto tasks + HITL approval
    suggestions: list[dict] | None  # e.g. after context change: suggest outline update / consistency check
    auto_next_tasks: list[str] | None
    human_approval: dict | None  # {"approved": True/False, "notes": "..."}
    active_issues: list[str] | None
