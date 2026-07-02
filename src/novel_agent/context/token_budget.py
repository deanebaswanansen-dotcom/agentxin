from __future__ import annotations

from pydantic import BaseModel, Field


class ContextItem(BaseModel):
    name: str
    content: str
    priority: int
    tokens: int
    included: bool = True


class TokenBudgetReport(BaseModel):
    used_tokens: int
    max_tokens: int
    included: list[str] = Field(default_factory=list)
    dropped: list[str] = Field(default_factory=list)


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 2)


def apply_budget(items: list[ContextItem], max_tokens: int) -> tuple[list[ContextItem], TokenBudgetReport]:
    used = 0
    included: list[ContextItem] = []
    dropped: list[ContextItem] = []
    for item in sorted(items, key=lambda value: value.priority):
        if used + item.tokens <= max_tokens:
            included.append(item.model_copy(update={"included": True}))
            used += item.tokens
        else:
            dropped.append(item.model_copy(update={"included": False}))
    return included, TokenBudgetReport(
        used_tokens=used,
        max_tokens=max_tokens,
        included=[item.name for item in included],
        dropped=[item.name for item in dropped],
    )
