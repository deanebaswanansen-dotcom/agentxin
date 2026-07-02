from __future__ import annotations

from collections.abc import Iterator

from novel_agent.config import AgentConfig
from novel_agent.providers.base import (
    CompletionChunk,
    CompletionOptions,
    CompletionResult,
    Message,
    ProviderPingResult,
)


class MockProvider:
    def __init__(self, config: AgentConfig):
        self.config = config

    def complete(self, messages: list[Message], options: CompletionOptions) -> CompletionResult:
        last = messages[-1].content if messages else ""
        return CompletionResult(text=f"MOCK_PROVIDER_OK\nMODEL={self.config.model}\n{last[:160]}")

    def stream(self, messages: list[Message], options: CompletionOptions) -> Iterator[CompletionChunk]:
        for part in self.complete(messages, options).text.splitlines(keepends=True):
            yield CompletionChunk(text=part)

    def ping(self) -> ProviderPingResult:
        return ProviderPingResult(
            provider="mock",
            base_url="mock://local",
            model=self.config.model or "mock-model",
            api_key_masked="not required",
            network="OK",
            auth="OK",
            chat_completion="OK",
            latency_ms=0,
        )
