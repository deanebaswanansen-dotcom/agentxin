from pathlib import Path

from pydantic import SecretStr

from novel_agent.config import AgentConfig
from novel_agent.providers.base import CompletionOptions, Message
from novel_agent.providers.mock import MockProvider


def test_mock_provider_ping_ok() -> None:
    provider = MockProvider(
        AgentConfig(
            provider="mock",
            model="mock-model",
            api_key=SecretStr(""),
            project_dir=Path("projects/example_novel"),
        )
    )

    result = provider.ping()

    assert result.ok
    assert result.network == "OK"
    assert result.auth == "OK"
    assert result.chat_completion == "OK"


def test_mock_provider_complete_is_deterministic() -> None:
    provider = MockProvider(
        AgentConfig(
            provider="mock",
            model="mock-model",
            api_key=SecretStr(""),
            project_dir=Path("projects/example_novel"),
        )
    )

    result = provider.complete([Message(role="user", content="hello")], CompletionOptions())

    assert result.text.startswith("MOCK_PROVIDER_OK")
    assert "hello" in result.text
