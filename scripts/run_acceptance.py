from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORT_ROOT = ROOT / "reports" / "acceptance"
EXCLUDES = {
    ".git",
    ".pytest_cache",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    "reports",
}


@dataclass
class StepResult:
    name: str
    command: str
    ok: bool
    exit_code: int
    duration_seconds: float
    stdout_tail: str = ""
    stderr_tail: str = ""
    notes: list[str] = field(default_factory=list)


def main() -> int:
    args = parse_args()
    started = datetime.now().strftime("%Y%m%d-%H%M%S")
    report_dir = Path(args.report_dir) if args.report_dir else REPORT_ROOT / started
    report_dir.mkdir(parents=True, exist_ok=True)
    temp_root = report_dir / "temp"
    temp_project = temp_root / "example_novel"
    copy_project(temp_project)

    print(f"[START] acceptance report = {report_dir}", flush=True)
    print("[INFO] progress output is enabled; internal model reasoning is not exposed.", flush=True)

    results: list[StepResult] = []
    mock_env = {
        "NOVEL_AGENT_PROVIDER": "mock",
        "NOVEL_AGENT_MODEL": "mock-model",
        "NOVEL_AGENT_PROJECT_DIR": str(temp_project),
    }
    real_env = {"NOVEL_AGENT_PROJECT_DIR": str(temp_project)}

    steps = [
        ("python version", [sys.executable, "--version"], {}),
        ("unit tests", [sys.executable, "-m", "pytest"], {}),
        ("cli help", ["novel-agent", "--help"], mock_env),
        ("config doctor mock", ["novel-agent", "config", "doctor"], mock_env),
        ("provider ping mock", ["novel-agent", "provider", "ping"], mock_env),
        ("context build", ["novel-agent", "context", "build", "--chapter", "ch003", "--task", "写第三章"], mock_env),
        ("memory update", ["novel-agent", "memory", "update", "ch910", "--summary", "acceptance memory update"], mock_env),
        ("mock flow", ["novel-agent", "test", "mock-flow", "--chapter", "ch911"], mock_env),
        ("chapter write mock", ["novel-agent", "chapter", "write", "ch912", "--task", "验收 mock 章节"], mock_env),
        ("chapter review", ["novel-agent", "chapter", "review", "ch912"], mock_env),
        ("chapter revise", ["novel-agent", "chapter", "revise", "ch912"], mock_env),
        ("idea command", ["novel-agent", "idea", "少年发现城市地下有灵脉"], mock_env),
        ("outline generate", ["novel-agent", "outline", "generate"], mock_env),
        ("export markdown", ["novel-agent", "export", "markdown"], mock_env),
        ("mcp smoke", [sys.executable, "-c", mcp_smoke_code(temp_project)], {}),
    ]

    for name, command, env in steps:
        results.append(run_step(name, command, env, args.timeout, args.show_output))
        if not results[-1].ok and args.stop_on_fail:
            break

    if args.include_real_api:
        real_steps = [
            ("provider ping deepseek", ["novel-agent", "provider", "ping"], real_env),
            ("integration provider ping", [sys.executable, "-m", "pytest", "-m", "integration", "tests/test_provider_deepseek_ping.py"], real_env),
        ]
        if args.real_chapter:
            real_steps.append(
                (
                    "chapter write deepseek",
                    ["novel-agent", "chapter", "write", "ch913", "--task", "验收真实 DeepSeek 章节"],
                    real_env,
                )
            )
        for name, command, env in real_steps:
            results.append(run_step(name, command, env, args.timeout, args.show_output))
            if not results[-1].ok and args.stop_on_fail:
                break

    evidence = verify_evidence(temp_project, args.real_chapter and args.include_real_api)
    secret_report = scan_for_secret_leaks()
    write_reports(report_dir, results, evidence, secret_report)

    ok = all(item.ok for item in results) and evidence["ok"] and secret_report["ok"]
    print(f"[DONE] status = {'PASS' if ok else 'FAIL'}", flush=True)
    print(f"[DONE] markdown = {report_dir / 'acceptance_report.md'}", flush=True)
    print(f"[DONE] json = {report_dir / 'acceptance_report.json'}", flush=True)
    return 0 if ok else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run end-to-end acceptance checks for novel-agent.")
    parser.add_argument("--include-real-api", action="store_true", help="Run real provider ping and integration tests.")
    parser.add_argument("--real-chapter", action="store_true", help="Generate one real DeepSeek chapter; requires --include-real-api.")
    parser.add_argument("--show-output", action="store_true", help="Stream command output while each step runs.")
    parser.add_argument("--stop-on-fail", action="store_true", help="Stop immediately after the first failed step.")
    parser.add_argument("--timeout", type=int, default=180, help="Per-command timeout in seconds.")
    parser.add_argument("--report-dir", default="", help="Custom report directory.")
    return parser.parse_args()


def copy_project(temp_project: Path) -> None:
    if temp_project.exists():
        shutil.rmtree(temp_project)
    temp_project.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / "projects" / "example_novel", temp_project)


def run_step(name: str, command: list[str], env: dict[str, str], timeout: int, show_output: bool) -> StepResult:
    started = time.perf_counter()
    printable = " ".join(command)
    print(f"[RUN] {name}: {printable}", flush=True)
    merged_env = os.environ.copy()
    merged_env.update(env)
    try:
        if show_output:
            completed = subprocess.run(command, cwd=ROOT, env=merged_env, timeout=timeout, text=True)
            stdout = ""
            stderr = ""
        else:
            completed = subprocess.run(
                command,
                cwd=ROOT,
                env=merged_env,
                timeout=timeout,
                text=True,
                capture_output=True,
            )
            stdout = completed.stdout
            stderr = completed.stderr
        duration = time.perf_counter() - started
        ok = completed.returncode == 0
        print(f"[{'OK' if ok else 'FAILED'}] {name} ({duration:.1f}s)", flush=True)
        return StepResult(
            name=name,
            command=printable,
            ok=ok,
            exit_code=completed.returncode,
            duration_seconds=round(duration, 3),
            stdout_tail=tail(stdout),
            stderr_tail=tail(stderr),
        )
    except subprocess.TimeoutExpired as exc:
        duration = time.perf_counter() - started
        print(f"[FAILED] {name} timeout after {timeout}s", flush=True)
        return StepResult(
            name=name,
            command=printable,
            ok=False,
            exit_code=124,
            duration_seconds=round(duration, 3),
            stdout_tail=tail(exc.stdout if isinstance(exc.stdout, str) else ""),
            stderr_tail=tail(exc.stderr if isinstance(exc.stderr, str) else ""),
            notes=[f"timeout_seconds={timeout}"],
        )


def tail(text: str, max_chars: int = 2000) -> str:
    return text[-max_chars:] if len(text) > max_chars else text


def mcp_smoke_code(temp_project: Path) -> str:
    return (
        "from pathlib import Path\n"
        "from novel_agent.mcp import NovelMCPClient\n"
        f"client = NovelMCPClient(Path(r'{temp_project}'))\n"
        "tools = client.list_tools()\n"
        "assert 'novel.project.load' in tools\n"
        "result = client.call_tool('novel.project.load', {})\n"
        "assert 'bible/premise.md' in result['loaded_files']\n"
        "print('mcp smoke ok')\n"
    )


def verify_evidence(project_dir: Path, expect_real_chapter: bool) -> dict:
    required = [
        "chapters/ch911.md",
        "chapters/ch912.md",
        "chapters/ch912.revised.md",
        "reviews/ch911.review.round1.json",
        "reviews/ch912.review.round1.json",
        "reviews/ch912.revision_plan.round1.md",
        "outline/idea.md",
        "outline/generated_outline.md",
        "exports/novel_export.md",
        "memory/summaries.jsonl",
        "memory/continuity.json",
        "memory/foreshadowing.json",
        "memory/character_arcs.json",
        "memory/timeline.json",
    ]
    if expect_real_chapter:
        required.extend(["chapters/ch913.md", "reviews/ch913.review.round1.json"])
    missing = [item for item in required if not (project_dir / item).exists()]
    summaries = (project_dir / "memory" / "summaries.jsonl").read_text(encoding="utf-8")
    memory_has_updates = "ch910" in summaries and "ch911" in summaries and "ch912" in summaries
    return {
        "ok": not missing and memory_has_updates,
        "project_dir": str(project_dir),
        "missing": missing,
        "memory_has_updates": memory_has_updates,
    }


def scan_for_secret_leaks() -> dict:
    sys.path.insert(0, str(ROOT / "src"))
    from novel_agent.config import load_config

    config = load_config(ROOT)
    secret = config.api_key.get_secret_value()
    if not secret or secret == "replace_me":
        return {"ok": True, "checked": False, "matches": 0}
    matches: list[str] = []
    for path in ROOT.rglob("*"):
        if should_skip(path):
            continue
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if secret in text:
            relative = path.relative_to(ROOT).as_posix()
            if relative != "backend/data/store.json":
                matches.append(relative)
    return {"ok": not matches, "checked": True, "matches": len(matches), "paths": matches}


def should_skip(path: Path) -> bool:
    relative_parts = path.relative_to(ROOT).parts if path.is_relative_to(ROOT) else path.parts
    return any(part in EXCLUDES for part in relative_parts)


def write_reports(report_dir: Path, results: list[StepResult], evidence: dict, secret_report: dict) -> None:
    payload = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "status": "PASS" if all(item.ok for item in results) and evidence["ok"] and secret_report["ok"] else "FAIL",
        "results": [item.__dict__ for item in results],
        "evidence": evidence,
        "secret_scan": secret_report,
    }
    (report_dir / "acceptance_report.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        "# Novel Agent Acceptance Report",
        "",
        f"Status: {payload['status']}",
        f"Created: {payload['created_at']}",
        "",
        "## Steps",
        "",
    ]
    for item in results:
        lines.append(f"- {'PASS' if item.ok else 'FAIL'} | {item.name} | {item.duration_seconds}s | exit={item.exit_code}")
    lines.extend(
        [
            "",
            "## Evidence",
            "",
            f"- Project dir: {evidence['project_dir']}",
            f"- Missing files: {', '.join(evidence['missing']) if evidence['missing'] else 'none'}",
            f"- Memory updates: {'PASS' if evidence['memory_has_updates'] else 'FAIL'}",
            f"- Secret scan: {'PASS' if secret_report['ok'] else 'FAIL'}",
        ]
    )
    (report_dir / "acceptance_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
