from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def checkpoint_dir(project_dir: Path) -> Path:
    path = project_dir / ".agent" / "checkpoints"
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_checkpoint(project_dir: Path, task_id: str, state: dict[str, Any]) -> Path:
    """Simple file checkpoint for recoverability (verify in tests)."""
    cp_dir = checkpoint_dir(project_dir)
    cp_file = cp_dir / f"{task_id}.json"
    # only serializable subset
    safe = {k: v for k, v in state.items() if isinstance(v, (str, int, float, bool, list, dict, type(None)))}
    cp_file.write_text(json.dumps(safe, ensure_ascii=False, indent=2), encoding="utf-8")
    return cp_file


def load_checkpoint(project_dir: Path, task_id: str) -> dict[str, Any] | None:
    cp_file = checkpoint_dir(project_dir) / f"{task_id}.json"
    if cp_file.exists():
        return json.loads(cp_file.read_text(encoding="utf-8"))
    return None
