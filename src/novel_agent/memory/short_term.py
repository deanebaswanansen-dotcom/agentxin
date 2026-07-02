from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping


def save_short_term_state(project_dir: Path, state: Mapping[str, Any]) -> Path:
    path = project_dir / ".agent" / "short_term" / f"{state['task_id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "task_id": state["task_id"],
        "goal": state["user_request"],
        "current_step": "memory_update",
        "draft_path": state["final_output_path"],
        "revision_round": state["revision_round"],
        "needs_human_review": state["needs_human_review"],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
