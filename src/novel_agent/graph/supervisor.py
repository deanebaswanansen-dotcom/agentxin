"""Supervisor LangGraph: routes web/CLI tasks to specialized sub-workflows."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

from novel_agent.graph.workflow import build_write_chapter_workflow, initial_state, run_chapter_flow
from novel_agent.graph.state import NovelAgentState

AgentTaskKind = Literal[
    "novel",
    "title",
    "outline",
    "polish",
    "diagnostic",
    "auto_next",
]


class SupervisorState(TypedDict, total=False):
    task: AgentTaskKind
    project_dir: str
    user_request: str
    chapter_id: str
    provider_config: dict | None
    route: str
    chapter_result: NovelAgentState | None
    summary: str


def route_task(state: SupervisorState) -> SupervisorState:
    task = state.get("task", "novel")
    mapping = {
        "novel": "onboard",
        "title": "onboard",
        "outline": "onboard",
        "polish": "critique",
        "diagnostic": "critique",
        "auto_next": "blueprint_chapter",
    }
    return {**state, "route": mapping.get(task, "onboard")}


def run_blueprint_chapter(state: SupervisorState) -> SupervisorState:
    project_dir = Path(state["project_dir"])
    chapter_id = state.get("chapter_id") or "ch001"
    result = run_chapter_flow(
        project_dir=project_dir,
        chapter_id=chapter_id,
        user_request=state.get("user_request", "auto_next"),
        provider_config=state.get("provider_config"),
    )
    return {
        **state,
        "chapter_result": result,
        "summary": f"Blueprint chapter flow finished for {chapter_id}",
    }


def run_onboard_placeholder(state: SupervisorState) -> SupervisorState:
    """Placeholder onboard node; web UI uses Node orchestrator for rich store sync."""
    return {
        **state,
        "summary": f"Onboard task={state.get('task')} acknowledged (use Node AgentOrchestrator for full web sync).",
    }


def run_critique_placeholder(state: SupervisorState) -> SupervisorState:
    workflow = build_write_chapter_workflow()
    base = initial_state(
        project_dir=Path(state["project_dir"]),
        chapter_id=state.get("chapter_id") or "ch001",
        user_request=state.get("user_request", "critique"),
        provider_config=state.get("provider_config"),
    )
    # Run only through critique loop entry (reuse compiled graph from write path)
    result = workflow.invoke(base)
    return {
        **state,
        "chapter_result": result,
        "summary": "Critique subgraph completed (mock/rule critique in nodes).",
    }


def _route_edge(state: SupervisorState) -> str:
    return state.get("route", "onboard")


def build_supervisor_workflow():
    graph = StateGraph(SupervisorState)
    graph.add_node("route_task", route_task)
    graph.add_node("onboard", run_onboard_placeholder)
    graph.add_node("blueprint_chapter", run_blueprint_chapter)
    graph.add_node("critique", run_critique_placeholder)

    graph.add_edge(START, "route_task")
    graph.add_conditional_edges(
        "route_task",
        _route_edge,
        {
            "onboard": "onboard",
            "blueprint_chapter": "blueprint_chapter",
            "critique": "critique",
        },
    )
    graph.add_edge("onboard", END)
    graph.add_edge("blueprint_chapter", END)
    graph.add_edge("critique", END)
    return graph.compile()


def run_supervisor(
    *,
    task: AgentTaskKind,
    project_dir: Path,
    user_request: str,
    chapter_id: str = "ch001",
    provider_config: dict | None = None,
) -> SupervisorState:
    workflow = build_supervisor_workflow()
    return workflow.invoke(
        {
            "task": task,
            "project_dir": str(project_dir),
            "user_request": user_request,
            "chapter_id": chapter_id,
            "provider_config": provider_config,
        },
    )