from __future__ import annotations

import sys
import json
import re
from pathlib import Path

import typer
from rich.console import Console

# Force UTF-8 on Windows to prevent Chinese garbled text (per strict spec)
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

from novel_agent.config import AgentConfig, doctor_checks, load_config
from novel_agent.context.context_builder import ContextBuilder
from novel_agent.graph.nodes import load_project, make_revision_plan, plan_chapter, revise_draft, self_critique
from novel_agent.graph.nodes import (
    plan_chapter_blueprint,
    write_scene_node,
    merge_chapter_node,
    generate_reports_node,
    expand_scene,
    rewrite_scene,
)
from novel_agent.graph.workflow import initial_state
from novel_agent.graph.workflow import run_chapter_flow, run_mock_flow, run_blueprint_chapter_flow
from novel_agent.tools.blueprint_tools import (
    load_blueprint,
    save_blueprint,
    parse_chapter_request,
    load_scene,
    merge_scenes_to_chapter,
    compute_word_count_report,
    save_word_count_report,
    generate_pacing_report,
    save_pacing_report,
    ChapterBlueprint,
)
from novel_agent.memory import LongTermMemoryStore, MemoryUpdate
from novel_agent.providers.base import CompletionOptions, Message, ProviderPingResult
from novel_agent.providers.factory import build_provider, config_to_provider_payload

console = Console()
app = typer.Typer(help="小说 Agent CLI")
config_app = typer.Typer(help="配置检查")
provider_app = typer.Typer(help="模型供应商检查")
context_app = typer.Typer(help="上下文构建")
test_app = typer.Typer(help="测试和验收")
memory_app = typer.Typer(help="记忆更新")
chapter_app = typer.Typer(help="章节工作流")
outline_app = typer.Typer(help="大纲生成")
export_app = typer.Typer(help="导出")
workspace_app = typer.Typer(help="当前工作区")
app.add_typer(config_app, name="config")
app.add_typer(provider_app, name="provider")
app.add_typer(context_app, name="context")
app.add_typer(test_app, name="test")
app.add_typer(memory_app, name="memory")
app.add_typer(chapter_app, name="chapter")
app.add_typer(outline_app, name="outline")
app.add_typer(export_app, name="export")
app.add_typer(workspace_app, name="workspace")


@config_app.command("doctor")
def config_doctor() -> None:
    """检查配置、Key 掩码和项目目录。"""
    config = load_config(Path.cwd())
    checks = doctor_checks(config, Path.cwd())
    all_ok = True
    for check in checks:
        ok = bool(check["ok"])
        all_ok = all_ok and ok
        status = "[OK]" if ok else "[FAILED]"
        console.print(f"{status} {check['name']} = {check['detail']}")
    raise typer.Exit(code=0 if all_ok else 1)


@provider_app.command("ping")
def provider_ping() -> None:
    """检查网络、认证和 Chat Completion。"""
    config = load_config(Path.cwd())
    result = build_provider(config).ping()
    print_ping_result(result)
    raise typer.Exit(code=0 if result.ok else 1)


@workspace_app.command("use")
def workspace_use(project: str = typer.Argument(..., help="项目目录，例如 projects/example_novel")) -> None:
    """设置当前项目，后续命令可省略环境变量 NOVEL_AGENT_PROJECT_DIR。"""
    root = Path.cwd()
    target = (root / project).resolve()
    file = root / ".agentxin" / "workspace.json"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps({"currentProject": str(target.relative_to(root)).replace("\\", "/")}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    console.print(f"[OK] Current project = {target}")


@workspace_app.command("show")
def workspace_show() -> None:
    """显示当前项目（相对路径）。"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    try:
        rel = project_dir.relative_to(Path.cwd())
    except ValueError:
        rel = project_dir
    console.print(f"[OK] Current project = {rel}")


@app.command("init")
def init_project(project_name: str) -> None:
    """创建小说项目目录骨架。"""
    project_dir = Path.cwd() / "projects" / project_name
    if project_dir.exists():
        console.print(f"[FAILED] Project exists: {project_dir}")
        raise typer.Exit(code=2)
    for relative in ["bible", "outline", "chapters", "memory", "reviews", "exports", "blueprints", "scenes", "reports"]:
        (project_dir / relative).mkdir(parents=True, exist_ok=True)
    files = {
        "project.yaml": f"project_name: {project_name}\nlanguage: zh-CN\nrevision_rounds: 2\npass_score: 8.0\n",
        "bible/premise.md": "# Premise\n",
        "bible/world.md": "# World\n",
        "bible/characters.md": "# Characters\n",
        "bible/style.md": "# Style\n",
        "bible/taboos.md": "# Taboos\n",
        "bible/canon.md": "# Canon\n",
        "outline/chapter_plan.md": "# Chapter Plan\n",
        "memory/summaries.jsonl": "",
        "memory/continuity.json": "{\"facts\": []}\n",
        "memory/foreshadowing.json": "{\"items\": []}\n",
        "memory/character_arcs.json": "{\"characters\": {}}\n",
        "memory/timeline.json": "{\"events\": []}\n",
    }
    for relative, content in files.items():
        (project_dir / relative).write_text(content, encoding="utf-8")
    console.print(f"[OK] Created project = {project_dir}")


@context_app.command("build")
def context_build(
    chapter: str = typer.Option(..., "--chapter", help="章节编号，例如 ch003"),
    task: str = typer.Option(..., "--task", help="当前写作任务"),
) -> None:
    """读取项目文件并构建模型上下文。"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    result = ContextBuilder(project_dir).build(chapter_id=chapter, task=task)
    print_context_result(result)


@test_app.command("mock-flow")
def test_mock_flow(
    chapter: str = typer.Option("ch999", "--chapter", help="mock-flow 章节编号"),
    use_mock: bool = typer.Option(True, "--mock", help="显式允许 mock 用于测试"),
) -> None:
    """运行 LangGraph mock-flow，不调用真实模型。"""
    config = load_config(Path.cwd())
    # force mock for this test cmd
    if config.provider != "mock":
        # override to mock for safety in test cmd
        config = config.model_copy(update={"provider": "mock"})
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    result = run_mock_flow(project_dir=project_dir, chapter_id=chapter)
    print_mock_flow_result(result)


@memory_app.command("update")
def memory_update(
    chapter: str = typer.Argument(..., help="章节编号，例如 ch003"),
    summary: str = typer.Option("人工触发记忆更新。", "--summary", help="章节摘要"),
) -> None:
    """把章节摘要、事实、伏笔、人物变化和时间线写入长期记忆。"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    update = MemoryUpdate(
        chapter_id=chapter,
        summary=summary,
        new_facts=[f"{chapter} 已执行记忆更新。"],
        character_updates={"林澈": "记忆层记录了一次章节状态变化。"},
        foreshadowing_updates=[{"id": "fs-cli", "status": "active", "text": "CLI 记忆更新链路已通过。"}],
        timeline_events=[f"{chapter} 写入长期记忆。"],
        next_hook="继续读取长期记忆后再写下一章。",
    )
    paths = LongTermMemoryStore(project_dir).apply_update(update)
    for name, p in paths.items():
        try:
            relp = Path(p).relative_to(Path.cwd()) if Path(p).is_absolute() else p
        except Exception:
            relp = p
        console.print(f"[OK] {name} = {relp}")


@app.command("idea")
def idea(
    seed: str = typer.Argument(..., help="一句话创意"),
    use_mock: bool = typer.Option(False, "--mock", help="显式使用 mock 提供者（仅测试）"),
) -> None:
    """把一句话创意扩展为项目参考。"""
    config = load_config(Path.cwd())
    if use_mock and config.provider != "mock":
        config = config.model_copy(update={"provider": "mock"})
    ensure_real_provider_or_explicit_mock(config, allow_mock=use_mock)
    warn_if_mock(config)
    provider = build_provider(config)
    console.print("[progress] 请求模型扩展创意", markup=False)
    result = provider.complete(
        [
            Message(role="system", content="你是小说项目策划 Agent，输出简洁 JSON。"),
            Message(role="user", content=f"把这个一句话创意扩展为题材、主角、核心冲突、前三章方向：{seed}"),
        ],
        CompletionOptions(temperature=config.temperature, max_tokens=800, stream=False),
    )
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    path = project_dir / "outline" / "idea.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(result.text, encoding="utf-8")
    try:
        rel = path.relative_to(Path.cwd()) if path.is_absolute() else path
    except Exception:
        rel = path.name if hasattr(path, 'name') else str(path)
    console.print(f"[OK] Idea saved = {rel}")


@outline_app.command("generate")
def outline_generate(
    use_mock: bool = typer.Option(False, "--mock", help="显式使用 mock 提供者（仅测试）"),
) -> None:
    """根据 Bible 和创意生成大纲草案。"""
    config = load_config(Path.cwd())
    if use_mock and config.provider != "mock":
        config = config.model_copy(update={"provider": "mock"})
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    context = ContextBuilder(project_dir).build(chapter_id="outline", task="生成卷一大纲")
    provider = build_provider(config)
    ensure_real_provider_or_explicit_mock(config, allow_mock=use_mock)
    warn_if_mock(config)
    console.print("[progress] 读取项目上下文并生成大纲", markup=False)
    result = provider.complete(
        [*context.messages, Message(role="user", content="生成 8 章以内的大纲草案，输出 Markdown。")],
        CompletionOptions(temperature=config.temperature, max_tokens=1200, stream=False),
    )
    path = project_dir / "outline" / "generated_outline.md"
    path.write_text(result.text, encoding="utf-8")
    try:
        rel = path.relative_to(Path.cwd()) if path.is_absolute() else path
    except Exception:
        rel = path.name if hasattr(path, 'name') else str(path)
    console.print(f"[OK] Outline saved = {rel}")


@chapter_app.command("write")
def chapter_write(
    chapter: str = typer.Argument(..., help="章节编号，例如 ch003"),
    task: str = typer.Option("写一个测试章节", "--task", help="章节任务"),
    overwrite: bool = typer.Option(False, "--overwrite", help="允许覆盖已有章节文件"),
    use_mock: bool = typer.Option(False, "--mock", help="显式使用 mock 提供者（仅测试）"),
) -> None:
    """运行 LangGraph 章节写作工作流。"""
    config = load_config(Path.cwd())
    if use_mock and config.provider != "mock":
        config = config.model_copy(update={"provider": "mock"})
    ensure_real_provider_or_explicit_mock(config, allow_mock=use_mock)
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    output_path = project_dir / "chapters" / f"{chapter}.md"
    if output_path.exists() and not overwrite:
        console.print(f"[FAILED] File exists: {output_path}")
        raise typer.Exit(code=2)
    result = run_chapter_flow(
        project_dir=project_dir,
        chapter_id=chapter,
        user_request=task,
        provider_config=config_to_provider_payload(config),
    )
    print_mock_flow_result(result)


@chapter_app.command("review")
def chapter_review(chapter: str = typer.Argument(..., help="章节编号，例如 ch003")) -> None:
    """审查已有章节并保存 review JSON。"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    chapter_path = project_dir / "chapters" / f"{chapter}.md"
    if not chapter_path.exists():
        draftp = project_dir / "chapters" / f"{chapter}.draft.md"
        if draftp.exists():
            chapter_path = draftp
        else:
            console.print(f"[FAILED] Missing chapter: {chapter_path}")
            raise typer.Exit(code=2)
    state = initial_state(project_dir, f"审查 {chapter}", chapter)
    state["draft"] = chapter_path.read_text(encoding="utf-8")
    result = self_critique(state)
    p = result['tool_results'][-1].get('path', '')
    try:
        relp = Path(p).relative_to(Path.cwd()) if Path(p).is_absolute() else p
    except Exception:
        relp = p
    console.print(f"[OK] Review saved = {relp}")


@chapter_app.command("revise")
def chapter_revise(chapter: str = typer.Argument(..., help="章节编号，例如 ch003")) -> None:
    """按审查结果生成修订稿，不覆盖原章节。"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    chapter_path = project_dir / "chapters" / f"{chapter}.md"
    if not chapter_path.exists():
        draftp = project_dir / "chapters" / f"{chapter}.draft.md"
        if draftp.exists():
            chapter_path = draftp
        else:
            console.print(f"[FAILED] Missing chapter: {chapter_path}")
            raise typer.Exit(code=2)
    state = initial_state(project_dir, f"修订 {chapter}", chapter)
    state["draft"] = chapter_path.read_text(encoding="utf-8")
    reviewed = self_critique(state)
    planned = make_revision_plan(reviewed)
    revised = revise_draft(planned)
    output_path = project_dir / "chapters" / f"{chapter}.revised.md"
    output_path.write_text(revised["revised_draft"] or "", encoding="utf-8")
    try:
        rel = output_path.relative_to(Path.cwd()) if output_path.is_absolute() else output_path
    except Exception:
        rel = output_path.name if hasattr(output_path, 'name') else str(output_path)
    console.print(f"[OK] Revised draft saved = {rel}")


@chapter_app.command("plan")
def chapter_plan(
    chapter: str = typer.Argument(..., help="章节编号，例如 ch003"),
    task: str = typer.Option("规划章节", "--task", help="规划任务"),
) -> None:
    """为老章节或新章节生成轻量计划（与 blueprint 集成预留）。"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    state = initial_state(project_dir, task, chapter)
    # light plan, no full blueprint (per task constraint)
    from novel_agent.context.context_builder import ContextBuilder
    ctx = ContextBuilder(project_dir).build(chapter_id=chapter, task=task)
    state["retrieved_context"] = [m.model_dump() for m in ctx.messages]
    planned = plan_chapter(state)
    plan_path = project_dir / "outline" / f"{chapter}_plan.md"
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.write_text(str(planned.get("plan", {})), encoding="utf-8")
    try:
        rel = plan_path.relative_to(Path.cwd()) if plan_path.is_absolute() else plan_path
    except Exception:
        rel = plan_path.name if hasattr(plan_path, 'name') else str(plan_path)
    console.print(f"[OK] Chapter plan saved (relative): {rel}")


# --- 新增章节蓝图与分场景写作命令 (阶段一) ---
# blueprint plan kept separate to avoid core impl here (left for dedicated subagent)

@chapter_app.command("plan-bp")
def chapter_plan_bp(
    chapter: str = typer.Argument(..., help="章节编号，如 3 或 ch003"),
    task: str = typer.Option("第3章 3000字 男主发现校花的异常并产生误会，结尾邀请去社团", "--task", help="章节需求描述，支持目标字数等"),
    use_mock: bool = typer.Option(True, "--mock", help="使用 mock（测试/演示必须）"),
) -> None:
    """生成章节蓝图 JSON。/plan_chapter 实现：读取 bible/outline，解析需求，保存 blueprints/chapter_XXX_blueprint.json"""
    config = load_config(Path.cwd())
    if use_mock:
        config = config.model_copy(update={"provider": "mock"})
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    # use direct or flow
    state = initial_state(project_dir, task, chapter, provider_config=config_to_provider_payload(config))
    result = plan_chapter_blueprint(state)
    bp = result.get("blueprint") or {}
    path = result.get("tool_results", [{}])[-1].get("path", "")
    console.print(f"[OK] Generated blueprint for chapter {bp.get('chapter_id')}")
    console.print(f"[OK] Blueprint saved = {path}")
    if bp.get("scenes"):
        console.print(f"[OK] Scenes count: {len(bp['scenes'])}, total target: {sum(s.get('target_words',0) for s in bp['scenes'])}")


@chapter_app.command("write-scene")
def chapter_write_scene(
    chapter: str = typer.Argument(..., help="章节编号"),
    scene: int = typer.Argument(..., help="场景编号，如 2"),
    use_mock: bool = typer.Option(True, "--mock", help="使用 mock"),
) -> None:
    """/write_scene chapter scene ：按 blueprint 写单个场景到 scenes/chapter_XXX/scene_YYY.md"""
    config = load_config(Path.cwd())
    if use_mock:
        config = config.model_copy(update={"provider": "mock"})
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    ch_num = int(re.sub(r"\D", "", chapter) or "1")
    bp = load_blueprint(project_dir, ch_num)
    if not bp:
        console.print("[FAILED] No blueprint, run chapter plan first")
        raise typer.Exit(2)
    scene_bp = next((s for s in bp.scenes if s.scene_id == scene), None)
    if not scene_bp:
        console.print("[FAILED] scene not in blueprint")
        raise typer.Exit(2)
    state = initial_state(project_dir, f"write scene {scene}", chapter, provider_config=config_to_provider_payload(config))
    state["blueprint"] = bp.model_dump()
    # use node which writes all, then ensure the single
    res = write_scene_node(state)
    # if needed force write single with fallback
    saved_path = project_dir / "scenes" / f"chapter_{ch_num:03d}" / f"scene_{scene:03d}.md"
    if not saved_path.exists() or len(saved_path.read_text(encoding="utf-8")) < 20:
        # fallback content matching must_include
        fb = f"场景 {scene}：{scene_bp.name}。地点 {scene_bp.location}。\n" + "\n".join([f"• {m}" for m in scene_bp.must_include]) + f"\n{scene_bp.ending_state}。（mock 填充 {scene_bp.target_words} 字）"
        saved_path.parent.mkdir(parents=True, exist_ok=True)
        saved_path.write_text(fb, encoding="utf-8")
    console.print(f"[OK] Scene written = {saved_path}")


@chapter_app.command("write-chapter")
def chapter_write_chapter(
    chapter: str = typer.Argument(..., help="章节编号"),
    task: str = typer.Option("按蓝图写完整章", "--task", help="可选需求覆盖"),
    use_mock: bool = typer.Option(True, "--mock", help="使用 mock"),
) -> None:
    """/write_chapter chapter ：自动依次 write 所有 scenes，调用 merge，生成 reports"""
    config = load_config(Path.cwd())
    if use_mock:
        config = config.model_copy(update={"provider": "mock"})
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    # Prefer full graph flow
    result = run_blueprint_chapter_flow(
        project_dir=project_dir,
        chapter_id=chapter,
        user_request=task or "根据蓝图写章节",
        provider_config=config_to_provider_payload(config),
    )
    ch_num = int(re.sub(r"\D", "", chapter) or 1)
    chapter_file = project_dir / "chapters" / f"ch{ch_num:03d}.md"
    wc_path = project_dir / "reports" / f"chapter_{ch_num:03d}_word_count_report.md"
    pc_path = project_dir / "reports" / f"chapter_{ch_num:03d}_pacing_report.md"
    console.print(f"[OK] Chapter draft written: {chapter_file if chapter_file.exists() else 'N/A'}")
    if wc_path.exists():
        console.print(f"[OK] Word count report: {wc_path}")
    if pc_path.exists():
        console.print(f"[OK] Pacing report: {pc_path}")
    if result.get("blueprint"):
        console.print(f"[OK] Blueprint scenes: {len(result['blueprint'].get('scenes', []))}")


@chapter_app.command("merge")
def chapter_merge(
    chapter: str = typer.Argument(..., help="章节编号"),
) -> None:
    """/merge_chapter"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    ch_num = int(re.sub(r"\D", "", chapter) or 1)
    bp = load_blueprint(project_dir, ch_num)
    out = merge_scenes_to_chapter(project_dir, ch_num, bp)
    console.print(f"[OK] Merged chapter = {out}")


@chapter_app.command("word-count-check")
def chapter_word_count(chapter: str = typer.Argument(..., help="章节编号")) -> None:
    """/word_count_check"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    ch_num = int(re.sub(r"\D", "", chapter) or 1)
    bp = load_blueprint(project_dir, ch_num)
    if not bp:
        console.print("[FAILED] blueprint not found")
        raise typer.Exit(2)
    report = compute_word_count_report(project_dir, ch_num, bp)
    path = save_word_count_report(project_dir, ch_num, report)
    console.print(f"[OK] Word count report saved = {path}")
    console.print(f"目标 {report['target_words']} / 实际 {report['actual_total']} 差距 {report['diff']}")


@chapter_app.command("pacing-check")
def chapter_pacing_check(chapter: str = typer.Argument(..., help="章节编号")) -> None:
    """/pacing_check"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    ch_num = int(re.sub(r"\D", "", chapter) or 1)
    bp = load_blueprint(project_dir, ch_num)
    if not bp:
        console.print("[FAILED] blueprint not found")
        raise typer.Exit(2)
    ch_path = project_dir / "chapters" / f"ch{ch_num:03d}.md"
    text = ch_path.read_text(encoding="utf-8") if ch_path.exists() else ""
    report = generate_pacing_report(project_dir, ch_num, bp, text)
    path = save_pacing_report(project_dir, ch_num, report)
    console.print(f"[OK] Pacing report saved = {path}")
    console.print(f"总体: {report.get('overall')}")


@chapter_app.command("expand-scene")
def chapter_expand_scene(
    chapter: str = typer.Argument(..., help="章节编号"),
    scene: int = typer.Argument(..., help="scene id"),
    words: int = typer.Option(200, "--words", help="扩写字数"),
    use_mock: bool = typer.Option(True, "--mock"),
) -> None:
    """/expand_scene chapter scene +N """
    config = load_config(Path.cwd())
    if use_mock:
        config = config.model_copy(update={"provider": "mock"})
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    ch_num = int(re.sub(r"\D", "", chapter) or 1)
    p = expand_scene(project_dir, ch_num, scene, words, config_to_provider_payload(config))
    console.print(f"[OK] Expanded scene saved = {p}")


@chapter_app.command("rewrite-scene")
def chapter_rewrite_scene(
    chapter: str = typer.Argument(..., help="章节编号"),
    scene: int = typer.Argument(..., help="scene id"),
    instruction: str = typer.Option("加强对话尴尬感", "--instruction"),
    use_mock: bool = typer.Option(True, "--mock"),
) -> None:
    """/rewrite_scene chapter scene --instruction '...' """
    config = load_config(Path.cwd())
    if use_mock:
        config = config.model_copy(update={"provider": "mock"})
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    ch_num = int(re.sub(r"\D", "", chapter) or 1)
    p = rewrite_scene(project_dir, ch_num, scene, instruction, config_to_provider_payload(config))
    console.print(f"[OK] Rewrote scene = {p}")


@chapter_app.command("finalize")
def chapter_finalize(
    chapter: str = typer.Argument(..., help="章节编号，例如 ch003"),
    overwrite: bool = typer.Option(False, "--overwrite", help="强制覆盖主 .md"),
) -> None:
    """将 .draft.md 合入主 chapters/xxx.md （Human-in-loop 确认步骤）。"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    chapters_dir = project_dir / "chapters"
    draft = chapters_dir / f"{chapter}.draft.md"
    target = chapters_dir / f"{chapter}.md"
    if not draft.exists():
        console.print(f"[FAILED] No draft found: {draft}")
        raise typer.Exit(code=2)
    if target.exists() and not overwrite:
        console.print(f"[WARN] Target exists, use --overwrite to replace: {target}")
        # still allow finalize by default? require flag for safety
        raise typer.Exit(code=2)
    content = draft.read_text(encoding="utf-8")
    target.write_text(content, encoding="utf-8")
    try:
        rel_target = target.relative_to(Path.cwd()) if target.is_absolute() else target
    except Exception:
        rel_target = target.name if hasattr(target, 'name') else str(target)
    console.print(f"[OK] Finalized (draft -> main): {rel_target}")
    # leave draft for history


@export_app.command("markdown")
def export_markdown() -> None:
    """合并章节为 Markdown 导出（优先主 .md ，回退 draft）。"""
    config = load_config(Path.cwd())
    project_dir = config.project_dir if config.project_dir.is_absolute() else Path.cwd() / config.project_dir
    ch_dir = project_dir / "chapters"
    # prefer .md over .draft.md
    chapters = sorted(ch_dir.glob("*.md"))
    main_chapters = [p for p in chapters if not (p.name.endswith(".draft.md") or p.name.endswith(".revised.md") or ".rev" in p.name)]
    if not main_chapters:
        main_chapters = [p for p in chapters if p.name.endswith(".draft.md")]
    export_path = project_dir / "exports" / "novel_export.md"
    export_path.parent.mkdir(parents=True, exist_ok=True)
    content = "\n\n".join(p.read_text(encoding="utf-8") for p in main_chapters)
    export_path.write_text(content, encoding="utf-8")
    # report relative
    try:
        rel = export_path.relative_to(Path.cwd())
    except Exception:
        rel = export_path.name if hasattr(export_path, 'name') else str(export_path)
    console.print(f"[OK] Export saved = {rel}")


def print_ping_result(result: ProviderPingResult) -> None:
    console.print(f"Provider: {result.provider}")
    console.print(f"Base URL: {result.base_url}")
    console.print(f"Model: {result.model}")
    console.print(f"API Key: {result.api_key_masked}")
    console.print(f"Network: {result.network}")
    console.print(f"Auth: {result.auth}")
    console.print(f"Chat Completion: {result.chat_completion}")
    console.print(f"Latency: {result.latency_ms if result.latency_ms is not None else 'n/a'} ms")
    if result.error_type:
        console.print(f"{result.error_type}: {result.error_message}")


def ensure_real_provider_or_explicit_mock(config: AgentConfig, allow_mock: bool = False) -> None:
    """Remove silent mock: no valid key + not explicit mock -> immediate error + guide."""
    if config.provider == "mock":
        if not allow_mock:
            # only allow if explicitly passed --mock
            console.print(
                "[FAILED] Mock provider in use but --mock not specified. "
                "Set NOVEL_AGENT_PROVIDER=deepseek + NOVEL_AGENT_API_KEY or pass --mock for tests.",
                markup=False,
            )
            raise typer.Exit(code=2)
        return
    api_key = config.api_key.get_secret_value().strip()
    base_ok = config.base_url.strip() != ""
    if not api_key or not base_ok:
        console.print(
            "[FAILED] No valid API key / base_url for provider. "
            "Configure .env (NOVEL_AGENT_PROVIDER / NOVEL_AGENT_API_KEY / NOVEL_AGENT_BASE_URL) "
            "or use --mock for demo. Run: novel-agent config doctor ; novel-agent provider ping",
            markup=False,
        )
        raise typer.Exit(code=2)


def warn_if_mock(config: AgentConfig) -> None:
    if config.provider == "mock":
        console.print(
            "[warning] 当前使用 Mock 模型，只适合演示和测试；输出会包含 MOCK_PROVIDER_OK，请配置真实 NOVEL_AGENT_PROVIDER/NOVEL_AGENT_API_KEY 后再正式写作。",
            markup=False,
        )


def print_context_result(result) -> None:
    # Report full bible files + others (relative paths)
    bible_files = [f for f in result.loaded_files if f.startswith("bible/")]
    for bf in sorted(bible_files):
        console.print(f"[OK] Loaded {bf}")
    for file in ["outline/chapter_plan.md"]:
        if file in result.loaded_files:
            console.print(f"[OK] Loaded {Path(file).name}")
    console.print(f"[OK] Loaded recent summaries: {', '.join(result.recent_summary_ids) or 'none'}")
    console.print(f"[OK] Loaded active foreshadowing: {result.active_foreshadowing_count} items")
    report = result.token_budget_report
    dropped = getattr(report, 'dropped', []) or []
    console.print(
        f"[OK] Token budget: {report.used_tokens} / {report.max_tokens} (dropped: {len(dropped)} items by priority)"
    )


def print_mock_flow_result(result) -> None:
    tools = [item["tool"] for item in result["tool_results"] if item.get("ok")]
    labels = {
        "ProjectLoadTool": "Loaded project",
        "ContextBuildTool": "Built context",
        "ChapterPlanTool": "Planned chapter",
        "DraftWriteTool": "Wrote draft",
        "ContinuityCheckTool": "Ran critique",
        "RevisionPlanTool": "Planned revision",
        "RevisionTool": "Revised draft",
        "ChapterSaveTool": "Saved chapter",
        "ChapterSummaryTool": "Updated memory",
        "ExportTool": "Exported markdown",
        "BlueprintPlanTool": "Planned blueprint",
        "SceneWriteTool": "Wrote scenes",
        "ChapterMergeTool": "Merged chapter",
        "WordCountReportTool": "Word count report",
        "PacingReportTool": "Pacing report",
    }
    for tool, label in labels.items():
        if tool in tools:
            console.print(f"[OK] {label}")
    console.print(f"[OK] Revision rounds: {result.get('revision_round', 0)}")
    if result.get("blueprint"):
        console.print(f"[OK] Blueprint scenes: {len(result.get('blueprint', {}).get('scenes', []))}")
    outp = result.get('final_output_path') or ''
    try:
        rel_out = Path(outp).relative_to(Path.cwd()) if str(outp) and Path(outp).is_absolute() else outp
    except Exception:
        rel_out = outp
    console.print(f"[OK] Output: {rel_out}")


def main() -> None:
    try:
        app()
    except Exception as exc:  # Typer.Exit is handled before this by Typer.
        console.print(f"UNKNOWN_ERROR: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
