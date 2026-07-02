from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


CRITIQUE_PROMPT = """你必须作为严格的批评者，按 Reflection Dimensions 逐一审查提供的章节草稿。
维度（必须覆盖）：
1. 设定一致性
2. 人物性格一致性
3. 人物关系变化合理性
4. 剧情因果逻辑
5. 时间线一致性
6. 伏笔推进情况
7. 爽点 / 冲突 / 钩子
8. 文风一致性
9. 重复、废话、水字数
10. 下一章衔接能力

输出必须是严格的 CritiqueResult JSON（Pydantic 兼容）：
- score (0-10)
- 每个维度列出 Issue (priority: high/medium/low, issue, evidence)
- revision_required: bool
- revision_plan: list of {priority, issue, action}
- 如果 score < 8.0 或有 high priority issue 或无法判断 -> revision_required=true
- 最多 2 轮修订后仍不合格 -> 必须设置 needs_human_review_reason
- 不确定时使用 NEEDS_HUMAN_REVIEW
永远使用中文分析内容。"""


Priority = Literal["low", "medium", "high"]


class Issue(BaseModel):
    priority: Priority
    issue: str
    evidence: str = ""


class RevisionAction(BaseModel):
    priority: Priority
    issue: str
    action: str


class CritiqueResult(BaseModel):
    chapter_id: str
    score: float
    pass_threshold: float = 8.0
    continuity_issues: list[Issue] = Field(default_factory=list)
    character_issues: list[Issue] = Field(default_factory=list)
    plot_issues: list[Issue] = Field(default_factory=list)
    style_issues: list[Issue] = Field(default_factory=list)
    pacing_issues: list[Issue] = Field(default_factory=list)
    foreshadowing_issues: list[Issue] = Field(default_factory=list)
    repetition_issues: list[Issue] = Field(default_factory=list)  # for 重复废话
    logic_issues: list[Issue] = Field(default_factory=list)  # extra for 因果/时间线
    revision_required: bool
    revision_plan: list[RevisionAction] = Field(default_factory=list)
    needs_human_review_reason: str = ""
    rounds_attempted: int = 0

    @model_validator(mode="after")
    def enforce_revision_rule(self) -> "CritiqueResult":
        has_high_issue = any(issue.priority == "high" for issue in self.all_issues())
        should_revise = self.score < self.pass_threshold or has_high_issue
        if self.revision_required != should_revise:
            self.revision_required = should_revise
        if self.rounds_attempted >= 2 and (self.score < self.pass_threshold or has_high_issue):
            if not self.needs_human_review_reason:
                self.needs_human_review_reason = "最多2轮修订后仍未达标，需人工审查"
        return self

    def all_issues(self) -> list[Issue]:
        return [
            *self.continuity_issues,
            *self.character_issues,
            *self.plot_issues,
            *self.style_issues,
            *self.pacing_issues,
            *self.foreshadowing_issues,
            *self.repetition_issues,
            *self.logic_issues,
        ]


def critique_draft(chapter_id: str, draft: str, revision_round: int) -> CritiqueResult:
    """Mock/rule-based critique for tests. In production would call LLM with CRITIQUE_PROMPT + draft."""
    rounds = revision_round + 1  # current attempt count
    if "FORCE_REVIEW_FAIL" in draft:
        return CritiqueResult(
            chapter_id=chapter_id,
            score=6.5,
            plot_issues=[
                Issue(priority="high", issue="剧情因果未闭合", evidence="mock failure marker"),
            ],
            logic_issues=[Issue(priority="high", issue="时间线/因果不一致", evidence="FORCE_REVIEW_FAIL")],
            revision_required=True,
            revision_plan=[
                RevisionAction(priority="high", issue="剧情因果未闭合", action="人工确认章节因果链后再修订"),
            ],
            needs_human_review_reason="连续修订仍未解决 high priority issue",
            rounds_attempted=rounds,
        )
    if revision_round >= 2:
        # after 2 revisions still low
        return CritiqueResult(
            chapter_id=chapter_id,
            score=7.8,
            plot_issues=[Issue(priority="medium", issue="仍存问题", evidence="round limit reached")],
            revision_required=True,
            needs_human_review_reason="最多2轮修订后仍未达标 -> NEEDS_HUMAN_REVIEW",
            rounds_attempted=rounds,
        )
    if revision_round >= 1:
        # second round passes threshold
        return CritiqueResult(chapter_id=chapter_id, score=8.3, revision_required=False, rounds_attempted=rounds)
    return CritiqueResult(
        chapter_id=chapter_id,
        score=7.2,
        plot_issues=[
            Issue(priority="medium", issue="冲突压力不足", evidence="结尾选择成本偏低"),
        ],
        repetition_issues=[
            Issue(priority="low", issue="轻微描述重复", evidence="mock analysis"),
        ],
        revision_required=True,
        revision_plan=[
            RevisionAction(priority="medium", issue="冲突压力不足", action="增强场景压力和选择代价"),
        ],
        rounds_attempted=rounds,
    )
