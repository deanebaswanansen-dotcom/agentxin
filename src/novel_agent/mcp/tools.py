from __future__ import annotations

from pathlib import Path


class PathSecurityError(ValueError):
    pass


def ensure_project_path(project_dir: Path, requested: str | Path) -> Path:
    root = project_dir.resolve()
    target = (root / requested).resolve() if not Path(requested).is_absolute() else Path(requested).resolve()
    blocked_parts = {".env", ".git", ".ssh", "Cookies"}
    if any(part in blocked_parts for part in target.parts):
        raise PathSecurityError(f"blocked path: {requested}")
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise PathSecurityError(f"path escapes project_dir: {requested}") from exc
    return target
