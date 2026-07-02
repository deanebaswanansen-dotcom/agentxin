from __future__ import annotations

from typing import Any

from novel_agent.providers.openai_compatible import OpenAICompatibleProvider


class DeepSeekProvider(OpenAICompatibleProvider):
    provider_name = "deepseek"

    def provider_request_extras(self) -> dict[str, Any]:
        model = self.config.model.strip()
        host = self.config.base_url.strip().rstrip("/")
        if host == "https://api.deepseek.com" and model in {"deepseek-v4-flash", "deepseek-v4-pro"}:
            return {
                "thinking": {"type": "enabled"},
                "reasoning_effort": "high" if model == "deepseek-v4-pro" else "medium",
            }
        return {}
