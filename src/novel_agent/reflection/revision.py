from __future__ import annotations

from novel_agent.reflection.critic import RevisionAction


def build_revision_plan_markdown(round_number: int, actions: list[RevisionAction]) -> str:
    lines = [f"# Revision Plan Round {round_number}", ""]
    if not actions:
        lines.append("- 无需修订")
    else:
        lines.extend(f"- [{action.priority}] {action.issue}: {action.action}" for action in actions)
    return "\n".join(lines) + "\n"


def revise_draft_by_plan(draft: str, actions: list[RevisionAction]) -> str:
    if not actions:
        return draft
    notes = "\n".join(f"- {action.action}" for action in actions)
    return (
        f"{draft}\n\n"
        "【修订执行】\n"
        f"{notes}\n\n"
        "他意识到这次异常背后有人刻意引导，局势比预想更危险。"
    )
