from __future__ import annotations

from pydantic import SecretStr

from novel_agent.config import AgentConfig
from novel_agent.providers.deepseek import DeepSeekProvider
from novel_agent.providers.mock import MockProvider
from novel_agent.providers.openai_compatible import OpenAICompatibleProvider


def build_provider(config: AgentConfig):
    if config.provider == "mock":
        return MockProvider(config)
    if config.provider == "deepseek":
        return DeepSeekProvider(config)
    return OpenAICompatibleProvider(config)


def config_to_provider_payload(config: AgentConfig) -> dict:
    return {
        "provider": config.provider,
        "model": config.model,
        "base_url": config.base_url,
        "api_key": config.api_key.get_secret_value(),
        "timeout_seconds": config.timeout_seconds,
        "max_retries": config.max_retries,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "stream": False,
        "project_dir": str(config.project_dir),
        "log_level": config.log_level,
    }


def config_from_provider_payload(payload: dict) -> AgentConfig:
    return AgentConfig(
        provider=payload["provider"],
        model=payload["model"],
        base_url=payload.get("base_url", ""),
        api_key=SecretStr(payload.get("api_key", "")),
        timeout_seconds=payload.get("timeout_seconds", 120),
        max_retries=payload.get("max_retries", 3),
        temperature=payload.get("temperature", 0.75),
        max_tokens=payload.get("max_tokens", 4096),
        stream=payload.get("stream", False),
        project_dir=payload.get("project_dir", "projects/example_novel"),
        log_level=payload.get("log_level", "INFO"),
    )
