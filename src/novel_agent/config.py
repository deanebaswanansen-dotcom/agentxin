from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from pydantic import BaseModel, Field, SecretStr, field_validator


class AgentConfig(BaseModel):
    provider: str = "mock"
    model: str = "mock-model"
    base_url: str = ""
    api_key: SecretStr = Field(default_factory=lambda: SecretStr(""))
    timeout_seconds: int = 120
    max_retries: int = 3
    temperature: float = 0.75
    max_tokens: int = 4096
    stream: bool = True
    project_dir: Path = Path("projects/example_novel")
    log_level: str = "INFO"
    config_source: str = "defaults"
    dotenv_loaded: bool = False

    @field_validator("provider")
    @classmethod
    def normalize_provider(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized in {"mock", "deepseek", "openai-compatible"}:
            return normalized
        raise ValueError("provider must be mock, deepseek, or openai-compatible")

    @field_validator("timeout_seconds", "max_retries", "max_tokens")
    @classmethod
    def positive_int(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("value must be positive")
        return value

    @field_validator("temperature")
    @classmethod
    def valid_temperature(cls, value: float) -> float:
        if value < 0 or value > 2:
            raise ValueError("temperature must be between 0 and 2")
        return value


def load_config(cwd: Path | str | None = None) -> AgentConfig:
    root = Path(cwd) if cwd is not None else Path.cwd()
    dotenv_loaded = load_env_files(root)
    backend_store = load_backend_model_config(root)

    provider = read_env("NOVEL_AGENT_PROVIDER", "LLM_PROVIDER", default="")
    model = read_env("NOVEL_AGENT_MODEL", "LLM_MODEL", default="")
    base_url = read_env("NOVEL_AGENT_BASE_URL", "LLM_BASE_URL", default="")
    api_key = read_env("NOVEL_AGENT_API_KEY", "LLM_API_KEY", default="")
    source = ".env" if provider or model or base_url or api_key else "defaults"

    if backend_store and not (provider or model or base_url or api_key):
        provider = "deepseek" if "deepseek" in backend_store["base_url"] else "openai-compatible"
        model = backend_store["model"]
        base_url = backend_store["base_url"]
        api_key = backend_store["api_key"]
        source = "backend/data/store.json"

    provider = provider or "mock"
    model = model or ("mock-model" if provider == "mock" else "deepseek-v4-pro")
    project_dir = Path(os.getenv("NOVEL_AGENT_PROJECT_DIR", "") or read_workspace_project(root) or "projects/example_novel")

    return AgentConfig(
        provider=provider,
        model=model,
        base_url=base_url,
        api_key=SecretStr(api_key),
        timeout_seconds=read_int("NOVEL_AGENT_TIMEOUT_SECONDS", "LLM_TIMEOUT_MS", default=120),
        max_retries=read_int("NOVEL_AGENT_MAX_RETRIES", default=3),
        temperature=read_float("NOVEL_AGENT_TEMPERATURE", "LLM_TEMPERATURE", default=0.75),
        max_tokens=read_int("NOVEL_AGENT_MAX_TOKENS", "LLM_MAX_TOKENS", default=4096),
        stream=read_bool("NOVEL_AGENT_STREAM", default=True),
        project_dir=project_dir,
        log_level=os.getenv("NOVEL_AGENT_LOG_LEVEL", "INFO"),
        config_source=source,
        dotenv_loaded=dotenv_loaded,
    )


def read_workspace_project(root: Path) -> str | None:
    file = root / ".agentxin" / "workspace.json"
    if not file.exists():
        return None
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    current = raw.get("currentProject") if isinstance(raw, dict) else None
    return current.strip() if isinstance(current, str) and current.strip() else None


def load_env_files(root: Path) -> bool:
    loaded = False
    for file in [root / ".env", root / ".env.local"]:
        if file.exists():
            loaded = load_dotenv(file, override=False) or loaded
    return loaded


def load_backend_model_config(root: Path) -> dict[str, str] | None:
    store_path = root / "backend" / "data" / "store.json"
    if not store_path.exists():
        return None
    try:
        raw = json.loads(store_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    model_config = raw.get("modelConfig")
    if not isinstance(model_config, dict):
        return None
    base_url = model_config.get("baseUrl")
    api_key = model_config.get("apiKey")
    model = model_config.get("modelName")
    if not all(isinstance(item, str) for item in [base_url, api_key, model]):
        return None
    return {"base_url": base_url, "api_key": api_key, "model": model}


def read_env(primary: str, fallback: str | None = None, default: str = "") -> str:
    value = os.getenv(primary)
    if value is None and fallback is not None:
        value = os.getenv(fallback)
    return value.strip() if value is not None else default


def read_int(primary: str, fallback: str | None = None, default: int = 0) -> int:
    raw = read_env(primary, fallback, default="")
    if raw == "":
        return default
    value = int(raw)
    if primary == "NOVEL_AGENT_TIMEOUT_SECONDS":
        return value
    if fallback == "LLM_TIMEOUT_MS" and int(raw) > 1000:
        return max(1, int(raw) // 1000)
    return value


def read_float(primary: str, fallback: str | None = None, default: float = 0.0) -> float:
    raw = read_env(primary, fallback, default="")
    return default if raw == "" else float(raw)


def read_bool(primary: str, default: bool) -> bool:
    raw = os.getenv(primary)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def mask_secret(secret: SecretStr | str) -> str:
    value = secret.get_secret_value() if isinstance(secret, SecretStr) else secret
    if value == "":
        return ""
    chars = list(value)
    suffix = "".join(chars[-4:]) if len(chars) > 4 else chars[-1]
    return f"{chars[0]}{chars[1] if len(chars) > 1 else ''}-****{suffix}" if value.startswith("sk-") else f"****{suffix}"


def doctor_checks(config: AgentConfig, cwd: Path | None = None) -> list[dict[str, Any]]:
    root = cwd or Path.cwd()
    project_dir = config.project_dir if config.project_dir.is_absolute() else root / config.project_dir
    api_key = config.api_key.get_secret_value()
    try:
        rel_detail = str(project_dir.relative_to(root))
    except Exception:
        rel_detail = str(project_dir)
    return [
        {"ok": config.dotenv_loaded or config.config_source != "defaults", "name": ".env loaded", "detail": config.config_source},
        {"ok": config.provider in {"mock", "deepseek", "openai-compatible"}, "name": "provider", "detail": config.provider},
        {"ok": config.model.strip() != "", "name": "model", "detail": config.model},
        {"ok": config.provider == "mock" or config.base_url.strip() != "", "name": "base_url configured", "detail": config.base_url or "not required for mock"},
        {"ok": config.provider == "mock" or api_key.strip() != "", "name": "api_key exists and is masked", "detail": mask_secret(config.api_key) or "not required for mock"},
        {"ok": project_dir.exists(), "name": "project_dir exists", "detail": rel_detail},
    ]
