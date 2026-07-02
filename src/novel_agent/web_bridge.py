"""JSON stdin/stdout bridge for Node backend to invoke Python LangGraph supervisor."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from novel_agent.config import load_config
from novel_agent.graph.supervisor import run_supervisor
from novel_agent.graph.workflow import run_blueprint_chapter_flow
from novel_agent.providers.factory import config_to_provider_payload
from novel_agent.tools.blueprint_tools import (
    load_blueprint,
    load_all_scenes,
    compute_word_count_report,
    generate_pacing_report,
    save_word_count_report,
    save_pacing_report,
)


def _to_relative(path: Path, root: Path) -> str:
    """Convert to relative path for UI (per spec)."""
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except Exception:
        return str(path).replace("\\", "/")


def main() -> None:
    payload: dict = json.load(sys.stdin)
    task: str = payload.get("task", "auto_next")
    prompt: str = payload.get("prompt", "")
    project_dir_raw = payload.get("projectDir", ".")
    project_dir = Path(project_dir_raw)
    if not project_dir.is_absolute():
        project_dir = Path.cwd() / project_dir
    chapter_id: str = payload.get("chapterId", "ch001")
    scene_id: str | None = payload.get("sceneId")
    add_words: int | None = payload.get("addWords")
    instruction: str | None = payload.get("instruction")

    config = load_config(project_dir)
    provider_config = config_to_provider_payload(config)

    abs_project_dir = project_dir.resolve()
    rel_root = Path.cwd()

    result: dict = {}
    summary = ""
    blueprint: dict | None = None
    scene_contents: dict[str, str] = {}
    chapter_content: str = ""
    reports: dict = {}

    if task in ("plan_blueprint", "write_chapter_from_blueprint", "auto_next", "full_blueprint"):
        # Delegate to Python LangGraph blueprint workflow (single source of truth)
        flow_result = run_blueprint_chapter_flow(
            project_dir=abs_project_dir,
            chapter_id=chapter_id,
            user_request=prompt or "auto generate chapter blueprint and scenes",
            provider_config=provider_config,
        )
        blueprint = flow_result.get("blueprint")
        scene_contents = flow_result.get("scene_contents") or {}
        chapter_content = flow_result.get("chapter_content", "") or ""
        reports = {
            "word_count": flow_result.get("word_count_report"),
            "pacing": flow_result.get("pacing_report"),
        }
        summary = flow_result.get("summary", "") or f"Blueprint flow completed for {chapter_id}"
        result = flow_result
    elif task == "write_scene":
        # Single scene write via full flow (MVP; graph writes all when no prior)
        flow_result = run_blueprint_chapter_flow(
            project_dir=abs_project_dir,
            chapter_id=chapter_id,
            user_request=prompt or f"write scene {scene_id or ''}",
            provider_config=provider_config,
        )
        blueprint = flow_result.get("blueprint")
        scene_contents = flow_result.get("scene_contents") or {}
        if scene_id and scene_id in scene_contents:
            chapter_content = scene_contents[scene_id]
        summary = f"Scene write flow for {scene_id or chapter_id}"
        result = flow_result
    elif task in ("get_blueprint", "get_reports"):
        ch_num = int("".join(c for c in chapter_id if c.isdigit()) or "1")
        bp = load_blueprint(abs_project_dir, ch_num)
        blueprint = bp.model_dump() if bp else None
        scenes = load_all_scenes(abs_project_dir, ch_num) if bp else []
        scene_contents = {str(sid): content for sid, content in scenes}
        wc = compute_word_count_report(abs_project_dir, ch_num, bp) if bp else None
        pc = generate_pacing_report(abs_project_dir, ch_num, bp, chapter_content or "") if bp else None
        reports = {"word_count": wc, "pacing": pc}
        summary = f"Loaded blueprint/reports for chapter {chapter_id}"
    else:
        # Legacy supervisor path
        sup = run_supervisor(
            task=task,  # type: ignore[arg-type]
            project_dir=abs_project_dir,
            user_request=prompt,
            chapter_id=chapter_id,
            provider_config=provider_config,
        )
        result = sup
        summary = sup.get("summary", "")
        blueprint = sup.get("blueprint")
        chapter_content = sup.get("chapter_content", "")

    out: dict = {
        "ok": True,
        "task": task,
        "summary": summary,
        "chapterId": chapter_id,
        "projectDir": _to_relative(abs_project_dir, rel_root),
        "blueprint": blueprint,
        "sceneContents": scene_contents,
        "chapterContent": chapter_content,
        "reports": reports,
        "result": result,
    }
    if "tool_results" in result:
        out["toolResults"] = result["tool_results"]

    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


if __name__ == "__main__":
    main()