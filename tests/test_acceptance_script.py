from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "run_acceptance.py"
SPEC = importlib.util.spec_from_file_location("run_acceptance", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
run_acceptance = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = run_acceptance
SPEC.loader.exec_module(run_acceptance)


def test_tail_limits_output() -> None:
    assert run_acceptance.tail("abcdef", 3) == "def"


def test_mcp_smoke_code_contains_project_path(tmp_path: Path) -> None:
    code = run_acceptance.mcp_smoke_code(tmp_path)

    assert str(tmp_path) in code
    assert "novel.project.load" in code
