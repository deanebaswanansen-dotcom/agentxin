from novel_agent.reflection.critic import CritiqueResult


def score_passed(result: CritiqueResult) -> bool:
    return not result.revision_required
