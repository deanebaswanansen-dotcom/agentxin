from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from langgraph.graph import END, START, StateGraph

from novel_agent.graph.checkpoints import save_checkpoint
from novel_agent.graph.nodes import (
    build_context,
    export_or_finish,
    load_project,
    make_revision_plan,
    mark_human_review,
    needs_revision,
    plan_chapter,
    proactive_suggest,
    revise_draft,
    save_chapter,
    self_critique,
    update_memory,
    write_draft,
    # new blueprint module
    plan_chapter_blueprint,
    write_scene_node,
    merge_chapter_node,
    generate_reports_node,
)
from novel_agent.graph.state import NovelAgentState


def initial_state(
    project_dir: Path,
    user_request: str,
    chapter_id: str,
    provider_config: dict | None = None,
) -> NovelAgentState:
    return {
        "task_id": str(uuid4()),
        "project_dir": str(project_dir),
        "user_request": user_request,
        "chapter_id": chapter_id,
        "system_prompt": "",
        "project_context": {},
        "memory_context": {},
        "retrieved_context": [],
        "token_budget_report": {},
        "plan": None,
        "draft": None,
        "critique": None,
        "revision_plan": None,
        "revised_draft": None,
        "tool_results": [],
        "errors": [],
        "needs_human_review": False,
        "final_output_path": None,
        "revision_round": 0,
        "provider_config": provider_config,
        # new fields defaults
        "blueprint": None,
        "scenes": None,
        "scene_contents": None,
        "word_count_report": None,
        "pacing_report": None,
        "chapter_content": None,
        "reports": None,
        # Active fields
        "suggestions": [],
        "auto_next_tasks": ["self_critique", "update_memory"],
        "human_approval": None,
        "active_issues": [],
    }


def build_write_chapter_workflow():
    graph = StateGraph(NovelAgentState)
    graph.add_node("load_project", load_project)
    graph.add_node("build_context", build_context)
    graph.add_node("proactive_suggest", proactive_suggest)  # 主动建议支持（上下文变化后建议）
    graph.add_node("plan_chapter", plan_chapter)
    graph.add_node("write_draft", write_draft)
    graph.add_node("self_critique", self_critique)
    graph.add_node("make_revision_plan", make_revision_plan)
    graph.add_node("revise_draft", revise_draft)
    graph.add_node("human_review", mark_human_review)
    graph.add_node("save_chapter", save_chapter)
    graph.add_node("update_memory", update_memory)
    graph.add_node("export_or_finish", export_or_finish)

    graph.add_edge(START, "load_project")
    graph.add_edge("load_project", "build_context")
    graph.add_edge("build_context", "proactive_suggest")
    graph.add_edge("proactive_suggest", "plan_chapter")
    graph.add_edge("plan_chapter", "write_draft")
    graph.add_edge("write_draft", "self_critique")
    graph.add_conditional_edges(
        "self_critique",
        needs_revision,
        {
            "make_revision_plan": "make_revision_plan",
            "human_review": "human_review",
            "save_chapter": "save_chapter",
        },
    )
    graph.add_edge("make_revision_plan", "revise_draft")
    graph.add_edge("revise_draft", "self_critique")
    graph.add_edge("human_review", "save_chapter")
    graph.add_edge("save_chapter", "update_memory")
    graph.add_edge("update_memory", "export_or_finish")
    graph.add_edge("export_or_finish", END)
    return graph.compile()


def run_mock_flow(project_dir: Path, chapter_id: str = "ch999") -> NovelAgentState:
    return run_chapter_flow(
        project_dir=project_dir,
        chapter_id=chapter_id,
        user_request="mock-flow：验证项目读取、上下文构建、规划、草稿、反省、修订、记忆回写和导出。",
    )


def run_chapter_flow(
    project_dir: Path,
    chapter_id: str,
    user_request: str,
    provider_config: dict | None = None,
) -> NovelAgentState:
    workflow = build_write_chapter_workflow()
    state = initial_state(
        project_dir=project_dir,
        chapter_id=chapter_id,
        user_request=user_request,
        provider_config=provider_config,
    )
    result = workflow.invoke(state)
    # ensure checkpoint for recover (simple json)
    try:
        save_checkpoint(project_dir, result.get("task_id", "unknown"), result)
    except Exception:
        pass
    return result


def build_blueprint_chapter_workflow():
    """New workflow for plan -> write scenes -> merge -> reports (stage 1)."""
    graph = StateGraph(NovelAgentState)
    graph.add_node("load_project", load_project)
    graph.add_node("build_context", build_context)
    graph.add_node("plan_chapter_blueprint", plan_chapter_blueprint)
    graph.add_node("write_scene_node", write_scene_node)
    graph.add_node("merge_chapter_node", merge_chapter_node)
    graph.add_node("generate_reports_node", generate_reports_node)

    graph.add_edge(START, "load_project")
    graph.add_edge("load_project", "build_context")
    graph.add_edge("build_context", "plan_chapter_blueprint")
    # For simplicity in graph, write_scene_node will internally write ALL scenes if flag set
    graph.add_edge("plan_chapter_blueprint", "write_scene_node")
    graph.add_edge("write_scene_node", "merge_chapter_node")
    graph.add_edge("merge_chapter_node", "generate_reports_node")
    graph.add_edge("generate_reports_node", END)
    return graph.compile()


def run_blueprint_chapter_flow(
    project_dir: Path,
    chapter_id: str,
    user_request: str,
    provider_config: dict | None = None,
) -> NovelAgentState:
    """Run full plan_chapter -> write all scenes -> merge -> reports."""
    workflow = build_blueprint_chapter_workflow()
    state = initial_state(
        project_dir=project_dir,
        chapter_id=chapter_id,
        user_request=user_request,
        provider_config=provider_config,
    )
    return workflow.invoke(state)
