from __future__ import annotations

from pathlib import Path

import pytest

from novel_agent.cli import build_provider
from novel_agent.config import load_config


@pytest.mark.integration
def test_deepseek_provider_ping() -> None:
    config = load_config(Path.cwd())
    provider = build_provider(config)

    result = provider.ping()

    assert result.provider == "deepseek"
    assert result.ok is True
