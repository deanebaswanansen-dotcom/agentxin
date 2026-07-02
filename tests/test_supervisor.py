from pathlib import Path

from novel_agent.graph.supervisor import build_supervisor_workflow, run_supervisor


def test_supervisor_graph_compiles():
    workflow = build_supervisor_workflow()
    assert workflow is not None


def test_supervisor_routes_auto_next() -> None:
    project_dir = Path(__file__).resolve().parents[1] / "projects" / "example_novel"
    result = run_supervisor(
        task="auto_next",
        project_dir=project_dir,
        user_request="mock auto next",
        chapter_id="ch999",
        provider_config=None,
    )
    assert result.get("route") == "blueprint_chapter"
    assert result.get("chapter_result") is not None