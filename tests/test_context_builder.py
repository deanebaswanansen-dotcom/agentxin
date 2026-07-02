from pathlib import Path

from novel_agent.context.context_builder import ContextBuilder


def test_context_builder_loads_project_context() -> None:
    project_dir = Path("projects/example_novel")
    result = ContextBuilder(project_dir).build(chapter_id="ch003", task="写第三章")

    assert "bible/premise.md" in result.loaded_files
    assert "bible/characters.md" in result.loaded_files
    assert "bible/world.md" in result.loaded_files
    assert "outline/chapter_plan.md" in result.loaded_files
    # full bible support
    bible_count = sum(1 for k in result.loaded_files if k.startswith("bible/"))
    assert bible_count >= 4
    assert 1 <= len(result.recent_summary_ids) <= 12
    assert result.active_foreshadowing_count >= 0
    assert result.token_budget_report.used_tokens <= result.token_budget_report.max_tokens
    assert any("你是小说写作 Agent" in message.content for message in result.messages)
    # priority report
    assert hasattr(result.token_budget_report, "used_tokens")
