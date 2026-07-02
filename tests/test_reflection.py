from __future__ import annotations

from novel_agent.graph.nodes import mark_human_review, needs_revision
from novel_agent.graph.workflow import initial_state
from novel_agent.reflection import build_revision_plan_markdown, critique_draft, revise_draft_by_plan


def test_critique_requires_revision_before_pass_threshold() -> None:
    result = critique_draft("ch001", "草稿", revision_round=0)

    assert result.revision_required is True
    assert result.score == 7.2
    assert result.revision_plan[0].priority == "medium"


def test_critique_passes_after_revision_round() -> None:
    result = critique_draft("ch001", "修订后草稿", revision_round=1)

    assert result.revision_required is False
    assert result.score >= 8.0  # updated mock value 8.3 for round 2 logic


def test_revision_plan_and_revision_text() -> None:
    critique = critique_draft("ch001", "草稿", revision_round=0)
    plan = build_revision_plan_markdown(1, critique.revision_plan)
    revised = revise_draft_by_plan("草稿", critique.revision_plan)

    assert "# Revision Plan Round 1" in plan
    assert "增强场景压力和选择代价" in revised


def test_needs_human_review_after_two_failed_rounds(tmp_path) -> None:
    state = initial_state(tmp_path, "测试", "ch001")
    state["revision_round"] = 2
    state["critique"] = critique_draft("ch001", "FORCE_REVIEW_FAIL", revision_round=2).model_dump()

    assert needs_revision(state) == "human_review"
    assert mark_human_review(state)["needs_human_review"] is True


def test_critique_max_rounds_and_new_dims() -> None:
    # round 0 low
    c0 = critique_draft("ch002", "draft", 0)
    assert c0.revision_required
    assert len(c0.repetition_issues) + len(c0.plot_issues) > 0
    # after 2 rounds forces human
    c2 = critique_draft("ch002", "FORCE_REVIEW_FAIL", 2)
    assert c2.needs_human_review_reason
    assert c2.rounds_attempted >= 2
