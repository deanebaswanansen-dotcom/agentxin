from pathlib import Path

from pydantic import SecretStr

from novel_agent.config import AgentConfig, doctor_checks, load_config, mask_secret


def test_load_config_from_env_file(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("NOVEL_AGENT_PROVIDER", raising=False)
    (tmp_path / ".env").write_text(
        "\n".join(
            [
                "NOVEL_AGENT_PROVIDER=deepseek",
                "NOVEL_AGENT_MODEL=deepseek-v4-pro",
                "NOVEL_AGENT_BASE_URL=https://api.deepseek.com",
                "NOVEL_AGENT_API_KEY=sk-test-1234",
                "NOVEL_AGENT_PROJECT_DIR=projects/example_novel",
            ]
        ),
        encoding="utf-8",
    )
    (tmp_path / "projects" / "example_novel").mkdir(parents=True)

    config = load_config(tmp_path)

    assert config.provider == "deepseek"
    assert config.model == "deepseek-v4-pro"
    assert config.base_url == "https://api.deepseek.com"
    assert config.api_key.get_secret_value() == "sk-test-1234"
    assert config.dotenv_loaded is True


def test_doctor_checks_do_not_expose_full_key(tmp_path: Path) -> None:
    (tmp_path / "projects" / "example_novel").mkdir(parents=True)
    config = AgentConfig(
        provider="deepseek",
        model="deepseek-v4-pro",
        base_url="https://api.deepseek.com",
        api_key=SecretStr("sk-secret-abcdef"),
        project_dir=Path("projects/example_novel"),
        dotenv_loaded=True,
        config_source=".env",
    )

    checks = doctor_checks(config, tmp_path)
    serialized = repr(checks)

    assert all(check["ok"] for check in checks)
    assert "sk-secret-abcdef" not in serialized
    assert "****cdef" in serialized


def test_mask_secret() -> None:
    assert mask_secret(SecretStr("sk-secret-abcdef")) == "sk-****cdef"
