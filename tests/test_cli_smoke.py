from typer.testing import CliRunner

from novel_agent.cli import app


def test_cli_help() -> None:
    result = CliRunner().invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "小说 Agent CLI" in result.output


def test_provider_ping_mock(monkeypatch) -> None:
    monkeypatch.setenv("NOVEL_AGENT_PROVIDER", "mock")
    monkeypatch.setenv("NOVEL_AGENT_MODEL", "mock-model")
    result = CliRunner().invoke(app, ["provider", "ping"])

    assert result.exit_code == 0
    assert "Provider: mock" in result.output
    assert "Chat Completion: OK" in result.output


def test_context_build_command() -> None:
    result = CliRunner().invoke(
        app,
        ["context", "build", "--chapter", "ch003", "--task", "写第三章"],
    )

    assert result.exit_code == 0
    assert "Loaded bible/" in result.output  # full bible now reported with prefix
    assert "[OK] Loaded active foreshadowing:" in result.output
    assert "Token budget:" in result.output
