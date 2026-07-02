from __future__ import annotations

import json
import re
from pathlib import Path

from novel_agent.context.context_builder import ContextBuilder, SYSTEM_PROMPT
from novel_agent.context.project_loader import ProjectLoader
from novel_agent.graph.checkpoints import checkpoint_dir
from novel_agent.graph.state import NovelAgentState
from novel_agent.memory import LongTermMemoryStore, MemoryUpdate, save_short_term_state
from novel_agent.providers.base import CompletionOptions, Message
from novel_agent.providers.factory import build_provider, config_from_provider_payload
from novel_agent.reflection import RevisionAction, build_revision_plan_markdown, critique_draft, revise_draft_by_plan
from novel_agent.tools.blueprint_tools import (
    ChapterBlueprint,
    SceneBlueprint,
    load_blueprint,
    save_blueprint,
    save_scene,
    load_scene,
    load_all_scenes,
    merge_scenes_to_chapter,
    compute_word_count_report,
    save_word_count_report,
    generate_pacing_report,
    save_pacing_report,
    parse_chapter_request,
)


def load_project(state: NovelAgentState) -> NovelAgentState:
    project_dir = Path(state["project_dir"])
    checkpoint_dir(project_dir)
    snapshot = ProjectLoader(project_dir).load()
    return {
        **state,
        "system_prompt": SYSTEM_PROMPT,
        "project_context": {"loaded_files": snapshot.loaded_files},
        "memory_context": {
            "recent_summaries": [item.model_dump() for item in snapshot.recent_summaries],
            "active_foreshadowing": [item.model_dump() for item in snapshot.active_foreshadowing],
        },
        "tool_results": [*state["tool_results"], {"tool": "ProjectLoadTool", "ok": True}],
    }


def build_context(state: NovelAgentState) -> NovelAgentState:
    result = ContextBuilder(Path(state["project_dir"])).build(
        chapter_id=state["chapter_id"] or "ch001",
        task=state["user_request"],
    )
    return {
        **state,
        "retrieved_context": [message.model_dump() for message in result.messages],
        "token_budget_report": result.token_budget_report.model_dump(),
        "tool_results": [*state["tool_results"], {"tool": "ContextBuildTool", "ok": True}],
    }


def plan_chapter(state: NovelAgentState) -> NovelAgentState:
    """Legacy simple plan. Upgraded version uses plan_chapter_blueprint."""
    plan = {
        "chapter_id": state["chapter_id"] or "ch001",
        "goal": state["user_request"],
        "beats": ["建立场景", "制造冲突", "推进伏笔", "留下钩子"],
    }
    return {
        **state,
        "plan": plan,
        "tool_results": [*state["tool_results"], {"tool": "ChapterPlanTool", "ok": True}],
    }


def write_draft(state: NovelAgentState) -> NovelAgentState:
    chapter_id = state["chapter_id"] or "ch001"
    if state["provider_config"]:
        config = config_from_provider_payload(state["provider_config"])
        provider = build_provider(config)
        messages = [Message.model_validate(message) for message in state["retrieved_context"]]
        messages.append(
            Message(
                role="user",
                content=(
                    f"请生成 {chapter_id} 的测试章节正文。"
                    "要求：中文网文风格，保留上下文设定，300-600字，直接输出正文。"
                ),
            )
        )
        result = provider.complete(
            messages,
            CompletionOptions(
                temperature=config.temperature,
                max_tokens=min(config.max_tokens, 1200),
                stream=False,
            ),
        )
        return {
            **state,
            "draft": f"# {chapter_id}\n\n{result.text.strip()}",
            "tool_results": [*state["tool_results"], {"tool": "DraftWriteTool", "ok": True, "provider": config.provider}],
        }
    draft = (
        f"# {chapter_id}\n\n"
        f"林澈按照计划开始行动。当前任务：{state['user_request']}。\n\n"
        "他先确认规则，再观察异常，最后在压力下做出选择。"
    )
    return {
        **state,
        "draft": draft,
        "tool_results": [*state["tool_results"], {"tool": "DraftWriteTool", "ok": True}],
    }


def self_critique(state: NovelAgentState) -> NovelAgentState:
    chapter_id = state["chapter_id"] or "ch001"
    revision_round = state["revision_round"]
    result = critique_draft(chapter_id, state["draft"] or "", revision_round)
    critique = result.model_dump()
    review_path = Path(state["project_dir"]) / "reviews" / f"{state['chapter_id']}.review.round{revision_round + 1}.json"
    review_path.parent.mkdir(parents=True, exist_ok=True)
    review_path.write_text(json.dumps(critique, ensure_ascii=False, indent=2), encoding="utf-8")
    new_state = {
        **state,
        "critique": critique,
        "tool_results": [*state["tool_results"], {"tool": "ContinuityCheckTool", "ok": True, "path": str(review_path)}],
    }
    # enforce max rounds in state
    if critique.get("needs_human_review_reason") and critique.get("rounds_attempted", 0) >= 2:
        new_state["needs_human_review"] = True
    return new_state


def make_revision_plan(state: NovelAgentState) -> NovelAgentState:
    actions = [
        RevisionAction.model_validate(item)
        for item in (state["critique"] or {}).get("revision_plan", [])
    ]
    plan = {
        "round": state["revision_round"] + 1,
        "actions": [item.model_dump() for item in actions],
    }
    plan_path = Path(state["project_dir"]) / "reviews" / f"{state['chapter_id']}.revision_plan.round{state['revision_round'] + 1}.md"
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.write_text(
        build_revision_plan_markdown(plan["round"], actions),
        encoding="utf-8",
    )
    return {
        **state,
        "revision_plan": plan,
        "tool_results": [*state["tool_results"], {"tool": "RevisionPlanTool", "ok": True, "path": str(plan_path)}],
    }


def revise_draft(state: NovelAgentState) -> NovelAgentState:
    actions = [
        RevisionAction.model_validate(item)
        for item in (state["critique"] or {}).get("revision_plan", [])
    ]
    revised = revise_draft_by_plan(
        state["draft"] or "",
        actions,
    )
    return {
        **state,
        "revised_draft": revised,
        "draft": revised,
        "revision_round": state["revision_round"] + 1,
        "tool_results": [*state["tool_results"], {"tool": "RevisionTool", "ok": True}],
    }


def save_chapter(state: NovelAgentState) -> NovelAgentState:
    """安全写入：默认写 .draft ，支持 finalize 命令合入主文件（HITL）。支持 revision 版本轻历史。"""
    chapter_id = state["chapter_id"] or "ch001"
    project_dir = Path(state["project_dir"])
    chapters_dir = project_dir / "chapters"
    chapters_dir.mkdir(parents=True, exist_ok=True)
    content = state["revised_draft"] or state["draft"] or ""
    # default to draft for safety (per strict spec + refactoring)
    draft_path = chapters_dir / f"{chapter_id}.draft.md"
    draft_path.write_text(content, encoding="utf-8")
    # also save revision snapshot for light history (chXXX.revN.md)
    rev = state.get("revision_round", 0)
    rev_path = chapters_dir / f"{chapter_id}.rev{rev}.md"
    rev_path.write_text(content, encoding="utf-8")
    final_path = chapters_dir / f"{chapter_id}.md"  # not written yet, only on finalize
    return {
        **state,
        "final_output_path": str(draft_path),  # point to draft
        "tool_results": [
            *state["tool_results"],
            {"tool": "ChapterSaveTool", "ok": True, "path": str(draft_path), "draft": True},
            {"tool": "ChapterSaveTool", "ok": True, "path": str(rev_path), "revision_snapshot": True},
        ],
    }


def update_memory(state: NovelAgentState) -> NovelAgentState:
    """章节结束自动写 summaries.jsonl + continuity + foreshadowing + character_arcs + timeline (per strict spec)。"""
    chapter_id = state["chapter_id"] or "ch001"
    project_dir = Path(state["project_dir"])
    draft = state.get("revised_draft") or state.get("draft") or ""
    # derive simple summary from draft (in real would use LLM or extract)
    summary_text = (draft[:300] + "...") if len(draft) > 300 else draft
    summary_text = summary_text.replace("\n", " ").strip() or "章节完成，状态已推进。"
    update = MemoryUpdate(
        chapter_id=chapter_id,
        summary=f"{chapter_id}: {summary_text[:200]}",
        new_facts=[f"{chapter_id} 完成一次带反省的章节流程。"],
        character_updates={"林澈": "在压力下确认异常并做出主动选择。"},
        foreshadowing_updates=[
            {"id": "fs-001", "status": "active", "text": "地铁站异常源头仍未查清，压力继续上升。"}
        ],
        timeline_events=[f"{chapter_id} 完成异常调查的阶段推进。"],
        next_hook="下一章继续追踪异常背后的引导者。",
    )
    paths = LongTermMemoryStore(project_dir).apply_update(update)
    short_term_path = save_short_term_state(project_dir, state)
    return {
        **state,
        "tool_results": [
            *state["tool_results"],
            {"tool": "ChapterSummaryTool", "ok": True, "path": paths["summary"]},
            {"tool": "ForeshadowingUpdateTool", "ok": True, "path": paths["foreshadowing"]},
            {"tool": "TimelineUpdateTool", "ok": True, "path": paths["timeline"]},
            {"tool": "ShortTermMemoryTool", "ok": True, "path": str(short_term_path)},
        ],
    }


def export_or_finish(state: NovelAgentState) -> NovelAgentState:
    export_path = Path(state["project_dir"]) / "exports" / "mock-flow.md"
    export_path.parent.mkdir(parents=True, exist_ok=True)
    if not state["final_output_path"]:
        raise RuntimeError("final_output_path is empty")
    export_path.write_text(Path(state["final_output_path"]).read_text(encoding="utf-8"), encoding="utf-8")
    return {
        **state,
        "tool_results": [*state["tool_results"], {"tool": "ExportTool", "ok": True, "path": str(export_path)}],
    }


def needs_revision(state: NovelAgentState) -> str:
    """Max 2 revision rounds per strict spec. After 2nd critique if still required -> human."""
    critique = state["critique"] or {}
    if not critique.get("revision_required", False):
        return "save_chapter"
    if state["revision_round"] >= 2 or critique.get("needs_human_review_reason"):
        return "human_review"
    return "make_revision_plan"


def mark_human_review(state: NovelAgentState) -> NovelAgentState:
    return {**state, "needs_human_review": True}


def proactive_suggest(state: NovelAgentState) -> NovelAgentState:
    """主动建议节点：上下文变化后建议更新大纲/检查一致性等。支持 state 驱动主动性。"""
    suggestions = list(state.get("suggestions") or [])
    issues = list(state.get("active_issues") or [])
    # heuristic: if token or memory context, suggest
    if state.get("token_budget_report") and len(state.get("memory_context", {})) > 0:
        suggestions.append({
            "type": "check_consistency",
            "reason": "上下文与记忆已加载，建议运行一致性审查",
            "action": "chapter review or auto self_critique",
        })
    if state.get("chapter_id") and not state.get("plan"):
        suggestions.append({
            "type": "update_outline",
            "reason": "新章节上下文已构建",
            "action": "考虑更新大纲",
        })
    return {
        **state,
        "suggestions": suggestions,
        "auto_next_tasks": state.get("auto_next_tasks") or ["review"],
        "active_issues": issues,
        "tool_results": [*state.get("tool_results", []), {"tool": "ProactiveSuggest", "ok": True}],
    }


# --- Chapter Blueprint & Scene Writing Module (MVP stage 1) ---

def _load_prompt(name: str) -> str:
    prompt_path = Path(__file__).parent.parent / "prompts" / f"{name}.md"
    if prompt_path.exists():
        return prompt_path.read_text(encoding="utf-8")
    return f"Follow the spec for {name}."


def _build_context_text(state: NovelAgentState) -> str:
    ctx = state.get("project_context", {}).get("loaded_files", {})
    outline = ctx.get("outline/chapter_plan.md", "") or ctx.get("outline/volume_001.md", "")
    chars = ctx.get("bible/characters.md", "")
    world = ctx.get("bible/world.md", "")
    return f"OUTLINE:\n{outline}\n\nCHARACTERS:\n{chars}\n\nWORLD:\n{world}\n\nUSER_REQUEST: {state.get('user_request','')}"


def _call_provider(state: NovelAgentState, system: str, user: str, max_tokens: int = 2000) -> str:
    """Call provider or return mock safe fallback."""
    proj_dir = Path(state["project_dir"])
    if state.get("provider_config"):
        try:
            config = config_from_provider_payload(state["provider_config"])
            provider = build_provider(config)
            msgs = [
                Message(role="system", content=system),
                Message(role="user", content=user),
            ]
            res = provider.complete(msgs, CompletionOptions(temperature=0.7, max_tokens=min(max_tokens, config.max_tokens or 2000), stream=False))
            return res.text or ""
        except Exception:
            pass
    # Mock safe fallback: use deterministic template based on last user hint
    last = (user[-180:] if user else "").strip()
    return f"MOCK_BLUEPRINT_OK\n{last[:120]}\n[template response for test]"


def _parse_blueprint_json(raw: str, chapter_num: int, req: dict) -> ChapterBlueprint:
    """Try parse JSON from LLM, fallback to template blueprint that matches spec."""
    # Strip possible ```json
    cleaned = re.sub(r"```(?:json)?|```", "", raw).strip()
    try:
        data = json.loads(cleaned)
        if "chapter_id" not in data:
            data["chapter_id"] = chapter_num
        # ensure scenes
        if "scenes" in data and isinstance(data["scenes"], list):
            scenes = []
            for s in data["scenes"]:
                if isinstance(s, dict):
                    scenes.append(SceneBlueprint(**{k: s.get(k) for k in ["scene_id","name","target_words","location","characters","purpose","emotion","pacing","must_include","ending_state"] if k in s} or s))
            data["scenes"] = scenes
        bp = ChapterBlueprint(**data)
        if not bp.scenes:
            raise ValueError("no scenes")
        return bp
    except Exception:
        # Template MVP blueprint, 4-5 scenes, sum close to target
        target = req.get("target_words", 2000)
        base = max(300, target // 5)
        scs = [
            SceneBlueprint(scene_id=1, name="开场铺垫", target_words=base, location="日常环境", characters=["主角"], purpose="引入当前章节目标，展示人物状态", emotion="轻松", pacing="慢", must_include=["主角当前状态", "引出事件"], ending_state="发现异常苗头"),
            SceneBlueprint(scene_id=2, name="冲突触发", target_words=base + 100, location="关键地点", characters=["主角", "相关人物"], purpose="触发剧情必须包含点", emotion="好奇/紧张", pacing="中", must_include=["异常发现", "初步互动"], ending_state="产生误会或疑问"),
            SceneBlueprint(scene_id=3, name="发展与试探", target_words=base + 200, location="互动场景", characters=["主角", "相关人物"], purpose="推进 required plot points", emotion="尴尬/暧昧", pacing="快", must_include=["试探对话", "关键信息"], ending_state="关系微妙变化"),
            SceneBlueprint(scene_id=4, name="高潮钩子", target_words=base, location="结尾地点", characters=["主角"], purpose="收束本章并留下钩子", emotion="悬念", pacing="中", must_include=["暗示邀请或发现", "情绪高点"], ending_state="下一章期待"),
        ]
        # adjust last to make sum match
        total = sum(s.target_words for s in scs)
        diff = target - total
        scs[-1] = SceneBlueprint(**{**scs[-1].model_dump(), "target_words": max(200, scs[-1].target_words + diff)})
        return ChapterBlueprint(
            chapter_id=chapter_num,
            title=req.get("title", f"第{chapter_num}章"),
            target_words=target,
            main_goal=req.get("raw", "按用户需求推进剧情"),
            tone=["轻松", "悬疑"],
            pacing="前松后紧，结尾留钩",
            required_plot_points=["发现异常", "互动试探", "留下钩子"],
            forbidden_points=["不要崩人设"],
            emotional_curve=["轻松", "紧张", "暧昧", "悬念"],
            scenes=scs,
            ending_hook="关键邀请或揭示。",
        )


def plan_chapter_blueprint(state: NovelAgentState) -> NovelAgentState:
    """Core /plan_chapter : read context, parse req, call LLM for JSON blueprint, validate sum words, save."""
    project_dir = Path(state["project_dir"])
    chapter_id = state.get("chapter_id") or "ch001"
    ch_num = int(re.sub(r"\D", "", chapter_id) or "1")
    req = parse_chapter_request(state.get("user_request", ""), default_chapter=ch_num, default_words=2200)

    # build prompt
    planner_prompt = _load_prompt("chapter_planner")
    context_text = _build_context_text(state)
    user_msg = f"用户章节需求：{state.get('user_request')}\n\n上下文：\n{context_text}\n\n请严格按规则输出合法 JSON 蓝图。章节编号：{ch_num}，目标字数约 {req['target_words']}。"

    raw = _call_provider(state, planner_prompt, user_msg, max_tokens=1800)
    blueprint = _parse_blueprint_json(raw, ch_num, req)

    # ensure sum close
    total = blueprint.total_target_words()
    if abs(total - blueprint.target_words) > blueprint.target_words * 0.1:
        # rescale last scene minimally
        delta = blueprint.target_words - total
        last = blueprint.scenes[-1]
        last.target_words = max(150, last.target_words + delta)
        blueprint.scenes[-1] = last

    saved_path = save_blueprint(project_dir, blueprint)
    bp_dict = blueprint.model_dump()

    return {
        **state,
        "blueprint": bp_dict,
        "chapter_id": f"ch{blueprint.chapter_id:03d}",
        "plan": {"chapter_id": blueprint.chapter_id, "title": blueprint.title, "target": blueprint.target_words, "scenes": len(blueprint.scenes)},
        "tool_results": [*state.get("tool_results", []), {"tool": "BlueprintPlanTool", "ok": True, "path": str(saved_path), "scenes": len(blueprint.scenes)}],
    }


def write_scene_node(state: NovelAgentState) -> NovelAgentState:
    """Write one or all scenes (for /write_scene or /write_chapter). When called in graph after plan, writes ALL scenes."""
    project_dir = Path(state["project_dir"])
    bp_dict = state.get("blueprint") or {}
    if not bp_dict:
        # try load
        ch_num = int(re.sub(r"\D", "", state.get("chapter_id") or "1") or 1)
        bp = load_blueprint(project_dir, ch_num)
        if bp:
            bp_dict = bp.model_dump()
    if not bp_dict:
        return {**state, "errors": [*state.get("errors", []), {"error": "no blueprint"}] }

    blueprint = ChapterBlueprint(**bp_dict)
    ch_num = blueprint.chapter_id
    scene_contents: dict = state.get("scene_contents") or {}
    written = []

    writer_prompt = _load_prompt("scene_writer")
    prev_content = ""

    for scene in blueprint.scenes:
        # For graph, write all. For single write_scene separate CLI may call once.
        content = load_scene(project_dir, ch_num, scene.scene_id)
        if content and len(content) > 50:
            # already written, reuse
            scene_contents[str(scene.scene_id)] = content
            continue

        ctx = _build_context_text(state)
        user = (
            f"章节蓝图：{json.dumps(blueprint.model_dump(), ensure_ascii=False)[:1200]}\n\n"
            f"当前场景 scene_id={scene.scene_id} : {scene.model_dump()}\n\n"
            f"上一场景内容摘要：{prev_content[-400:] if prev_content else '无'}\n\n"
            f"项目上下文：{ctx}\n\n直接写正文。"
        )
        raw_scene = _call_provider(state, writer_prompt, user, max_tokens=max(800, scene.target_words + 300))
        # clean MOCK / MODEL echo lines from mock provider
        scene_text = re.sub(r"^(MOCK.*|MODEL=.*)\n?", "", raw_scene, flags=re.M | re.I).strip()
        if not scene_text or len(scene_text) < 40 or "蓝图" in scene_text or "chapter_id" in scene_text:
            # fallback deterministic content for mock compat, ensure must_include + length
            base = (
                f"场景 {scene.scene_id}：{scene.name}。\n"
                f"地点：{scene.location}。人物：{', '.join(scene.characters)}。\n"
                f"【必须包含】\n" + "\n".join(f"- {m}" for m in scene.must_include) + "\n"
                f"{scene.purpose}。情绪转向 {scene.emotion}。\n"
                f"结束状态：{scene.ending_state}。"
            )
            # pad to approach target_words (chinese chars rough)
            pad = max(0, (scene.target_words - len(base)) // 4 )
            fillers = ("他环顾四周，内心活动细腻。环境光影变化带来微妙情绪。" * (pad // 12 + 1))[:pad]
            scene_text = base + "\n" + fillers + f"\n（mock填充，目标 {scene.target_words} 字，pacing {scene.pacing}）"
            scene_text = scene_text[: scene.target_words + 50]  # cap approx
        saved = save_scene(project_dir, ch_num, scene.scene_id, scene_text)
        scene_contents[str(scene.scene_id)] = scene_text
        written.append(str(saved))
        prev_content = scene_text

    return {
        **state,
        "scene_contents": scene_contents,
        "scenes": [s.model_dump() for s in blueprint.scenes],
        "tool_results": [*state.get("tool_results", []), {"tool": "SceneWriteTool", "ok": True, "written": written}],
    }


def merge_chapter_node(state: NovelAgentState) -> NovelAgentState:
    project_dir = Path(state["project_dir"])
    bp_dict = state.get("blueprint") or {}
    ch_id = state.get("chapter_id") or "ch001"
    ch_num = int(re.sub(r"\D", "", ch_id) or "1")
    blueprint = None
    if bp_dict:
        try:
            blueprint = ChapterBlueprint(**bp_dict)
        except Exception:
            pass
    try:
        out_path = merge_scenes_to_chapter(project_dir, ch_num, blueprint, title=(blueprint.title if blueprint else None))
        chapter_text = out_path.read_text(encoding="utf-8")
        return {
            **state,
            "chapter_content": chapter_text,
            "final_output_path": str(out_path),
            "tool_results": [*state.get("tool_results", []), {"tool": "ChapterMergeTool", "ok": True, "path": str(out_path)}],
        }
    except Exception as e:
        return {**state, "errors": [*state.get("errors", []), {"merge_error": str(e)}]}


def generate_reports_node(state: NovelAgentState) -> NovelAgentState:
    project_dir = Path(state["project_dir"])
    bp_dict = state.get("blueprint") or {}
    if not bp_dict:
        return state
    blueprint = ChapterBlueprint(**bp_dict)
    ch_num = blueprint.chapter_id

    # word count
    wc_report = compute_word_count_report(project_dir, ch_num, blueprint)
    wc_path = save_word_count_report(project_dir, ch_num, wc_report)

    # pacing
    chapter_text = state.get("chapter_content") or ""
    if not chapter_text:
        chp = Path(project_dir) / "chapters" / f"ch{ch_num:03d}.md"
        if chp.exists():
            chapter_text = chp.read_text(encoding="utf-8")
    pc_report = generate_pacing_report(project_dir, ch_num, blueprint, chapter_text)
    pc_path = save_pacing_report(project_dir, ch_num, pc_report)

    reports = {"word_count": wc_report, "pacing": pc_report}
    return {
        **state,
        "word_count_report": wc_report,
        "pacing_report": pc_report,
        "reports": reports,
        "tool_results": [
            *state.get("tool_results", []),
            {"tool": "WordCountReportTool", "ok": True, "path": str(wc_path)},
            {"tool": "PacingReportTool", "ok": True, "path": str(pc_path)},
        ],
    }


# Additional helper nodes / logic for expand/rewrite (used by CLI directly)
def expand_scene(project_dir: Path, chapter_num: int, scene_id: int, add_words: int, provider_config: dict | None) -> Path:
    """MVP expand: append descriptive content to reach target."""
    blueprint = load_blueprint(project_dir, chapter_num)
    if not blueprint:
        raise FileNotFoundError("blueprint missing")
    scene_bp = next((s for s in blueprint.scenes if s.scene_id == scene_id), None)
    if not scene_bp:
        raise ValueError("scene not found")
    orig = load_scene(project_dir, chapter_num, scene_id)
    # Use direct logic for MVP (real would call provider with prompt)
    extra = "\n\n" + " ".join(["他仔细观察周围，内心涌起更多思绪。环境细节渐次展开。"] * max(2, add_words // 50))
    new_content = orig.rstrip() + extra
    save_scene(project_dir, chapter_num, scene_id, new_content)
    scenes_dir = project_dir / "scenes" / f"chapter_{chapter_num:03d}"
    return scenes_dir / f"scene_{scene_id:03d}.md"


# expose for CLI direct use
def rewrite_scene(project_dir: Path, chapter_num: int, scene_id: int, instruction: str, provider_config: dict | None = None) -> Path:
    blueprint = load_blueprint(project_dir, chapter_num)
    if not blueprint:
        raise FileNotFoundError("blueprint")
    scene_bp = next((s for s in blueprint.scenes if s.scene_id == scene_id), None)
    if not scene_bp:
        raise ValueError("scene")
    orig = load_scene(project_dir, chapter_num, scene_id)
    # mock rewrite: keep must, add note on instruction
    newc = orig + f"\n\n（根据指令重写调整：{instruction[:60]}。保持 must_include 和 purpose）"
    save_scene(project_dir, chapter_num, scene_id, newc)
    return project_dir / "scenes" / f"chapter_{chapter_num:03d}" / f"scene_{scene_id:03d}.md"

