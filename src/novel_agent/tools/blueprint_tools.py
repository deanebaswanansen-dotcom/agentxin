"""Blueprint tools for chapter planning, scene writing, merge, checks. MVP implementation."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator, ValidationInfo

from novel_agent.mcp.tools import ensure_project_path


class SceneBlueprint(BaseModel):
    scene_id: int
    name: str
    target_words: int
    location: str
    characters: list[str] = Field(default_factory=list)
    purpose: str
    emotion: str
    pacing: str
    must_include: list[str] = Field(default_factory=list)
    ending_state: str

    @field_validator("target_words")
    @classmethod
    def positive_words(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("target_words must be positive")
        return v

    @field_validator("pacing")
    @classmethod
    def valid_pacing(cls, v: str) -> str:
        if v not in ("慢", "中", "快"):
            return "中"  # fallback
        return v


class ChapterBlueprint(BaseModel):
    chapter_id: int
    title: str
    target_words: int
    main_goal: str
    tone: list[str] = Field(default_factory=list)
    pacing: str
    required_plot_points: list[str] = Field(default_factory=list)
    forbidden_points: list[str] = Field(default_factory=list)
    emotional_curve: list[str] = Field(default_factory=list)
    scenes: list[SceneBlueprint]
    ending_hook: str = ""

    @field_validator("scenes")
    @classmethod
    def validate_scenes_count_and_words(cls, scenes: list[SceneBlueprint], info: ValidationInfo) -> list[SceneBlueprint]:
        if not (3 <= len(scenes) <= 7):
            # allow during creation but warn in logic
            pass
        total = sum(s.target_words for s in scenes)
        target = info.data.get("target_words", 0) if hasattr(info, "data") else 0
        if target and abs(total - target) > target * 0.15:
            # still accept, caller can adjust
            pass
        return scenes

    def total_target_words(self) -> int:
        return sum(s.target_words for s in self.scenes)


def _get_blueprint_path(project_dir: Path, chapter_num: int) -> Path:
    return project_dir / "blueprints" / f"chapter_{chapter_num:03d}_blueprint.json"


def _get_scenes_dir(project_dir: Path, chapter_num: int) -> Path:
    return project_dir / "scenes" / f"chapter_{chapter_num:03d}"


def _get_chapter_path(project_dir: Path, chapter_id: str) -> Path:
    # support ch003 or 003
    ch = chapter_id if chapter_id.startswith("ch") else f"ch{int(chapter_id):03d}"
    return project_dir / "chapters" / f"{ch}.md"


def _get_report_dir(project_dir: Path) -> Path:
    return project_dir / "reports"


def load_blueprint(project_dir: Path, chapter_num: int) -> ChapterBlueprint | None:
    path = _get_blueprint_path(project_dir, chapter_num)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    # scenes may be dicts
    scenes = [SceneBlueprint(**s) if isinstance(s, dict) else s for s in data.get("scenes", [])]
    data["scenes"] = scenes
    return ChapterBlueprint(**data)


def save_blueprint(project_dir: Path, blueprint: ChapterBlueprint | dict) -> Path:
    if isinstance(blueprint, dict):
        bp = ChapterBlueprint(**blueprint)
    else:
        bp = blueprint
    path = _get_blueprint_path(project_dir, bp.chapter_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = bp.model_dump()
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def save_scene(project_dir: Path, chapter_num: int, scene_id: int, content: str) -> Path:
    scenes_dir = _get_scenes_dir(project_dir, chapter_num)
    scenes_dir.mkdir(parents=True, exist_ok=True)
    path = scenes_dir / f"scene_{scene_id:03d}.md"
    path.write_text(content.strip() + "\n", encoding="utf-8")
    return path


def load_scene(project_dir: Path, chapter_num: int, scene_id: int) -> str:
    path = _get_scenes_dir(project_dir, chapter_num) / f"scene_{scene_id:03d}.md"
    if path.exists():
        return path.read_text(encoding="utf-8")
    return ""


def load_all_scenes(project_dir: Path, chapter_num: int) -> list[tuple[int, str]]:
    scenes_dir = _get_scenes_dir(project_dir, chapter_num)
    if not scenes_dir.exists():
        return []
    items = []
    for p in sorted(scenes_dir.glob("scene_*.md")):
        m = re.search(r"scene_(\d+).md", p.name)
        if m:
            sid = int(m.group(1))
            items.append((sid, p.read_text(encoding="utf-8")))
    return sorted(items, key=lambda x: x[0])


def merge_scenes_to_chapter(project_dir: Path, chapter_num: int, blueprint: ChapterBlueprint | None = None, title: str | None = None) -> Path:
    scenes = load_all_scenes(project_dir, chapter_num)
    if not scenes:
        raise ValueError("No scenes to merge")
    ch_id = f"ch{chapter_num:03d}"
    header = f"# {title or (blueprint.title if blueprint else ch_id)}\n\n"
    body = "\n\n".join(content.strip() for _, content in scenes)
    full = header + body
    out_path = _get_chapter_path(project_dir, ch_id)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(full, encoding="utf-8")
    return out_path


def count_words(text: str) -> int:
    # Chinese + English word count, simple: remove non-word, count hanzi + words
    if not text:
        return 0
    # count Chinese chars + split English
    cn = len(re.findall(r'[\u4e00-\u9fff]', text))
    en = len(re.findall(r'[A-Za-z]+', text))
    other = len(re.findall(r'\S', text)) - cn - en  # punctuation etc rough
    return cn + en + max(0, other // 2)


def compute_word_count_report(project_dir: Path, chapter_num: int, blueprint: ChapterBlueprint) -> dict:
    scenes_dir = _get_scenes_dir(project_dir, chapter_num)
    report = {
        "chapter_id": chapter_num,
        "target_words": blueprint.target_words,
        "scenes": [],
        "actual_total": 0,
    }
    total = 0
    for scene in blueprint.scenes:
        content = load_scene(project_dir, chapter_num, scene.scene_id)
        actual = count_words(content)
        diff = actual - scene.target_words
        status = "OK" if abs(diff) <= scene.target_words * 0.15 else ("UNDER" if diff < 0 else "OVER")
        report["scenes"].append({
            "scene_id": scene.scene_id,
            "name": scene.name,
            "target_words": scene.target_words,
            "actual_words": actual,
            "diff": diff,
            "status": status,
        })
        total += actual
    report["actual_total"] = total
    report["diff"] = total - blueprint.target_words
    report["diff_percent"] = round((report["diff"] / blueprint.target_words) * 100, 1) if blueprint.target_words else 0
    return report


def save_word_count_report(project_dir: Path, chapter_num: int, report: dict) -> Path:
    reports_dir = _get_report_dir(project_dir)
    reports_dir.mkdir(parents=True, exist_ok=True)
    path = reports_dir / f"chapter_{chapter_num:03d}_word_count_report.md"
    lines = [
        f"# 第{chapter_num}章字数检查报告\n",
        f"目标字数：{report['target_words']}",
        f"实际字数：{report['actual_total']}",
        f"差距：{report['diff']} ({report['diff_percent']}%)\n",
        "## 场景字数统计\n",
        "| 场景 | 名称 | 目标字数 | 实际字数 | 差距 | 状态 |",
        "|------|------|----------|----------|------|------|",
    ]
    for s in report["scenes"]:
        lines.append(f"| scene_{s['scene_id']:03d} | {s['name']} | {s['target_words']} | {s['actual_words']} | {s['diff']} | {s['status']} |")
    lines.append("\n## 建议\n")
    if abs(report["diff"]) > report["target_words"] * 0.15:
        for s in report["scenes"]:
            if s["status"] != "OK":
                sign = "扩写" if s["diff"] < 0 else "精简"
                amt = abs(s["diff"])
                lines.append(f"- {sign} scene_{s['scene_id']:03d} 约 {amt} 字")
    else:
        lines.append("字数基本符合要求。")
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def generate_pacing_report(project_dir: Path, chapter_num: int, blueprint: ChapterBlueprint, chapter_text: str) -> dict:
    # Simple heuristic + blueprint based for MVP (real impl would LLM)
    actual_scenes = load_all_scenes(project_dir, chapter_num)
    issues = []
    score = 7.5
    if len(actual_scenes) < 3:
        issues.append({"scene": 0, "issue": "场景数量过少", "suggestion": "至少3个场景"})
    total_words = count_words(chapter_text)
    if abs(total_words - blueprint.target_words) > blueprint.target_words * 0.2:
        issues.append({"scene": 0, "issue": "整体字数偏差大", "suggestion": "检查各场景"})
    # check must_include roughly
    for scene in blueprint.scenes:
        content = load_scene(project_dir, chapter_num, scene.scene_id).lower()
        missing = [m for m in scene.must_include if m.lower()[:8] not in content]
        if missing:
            issues.append({"scene": scene.scene_id, "issue": f"可能未覆盖 must_include: {missing[0][:20]}", "suggestion": "补充相关描写"})
    if issues:
        score = max(5.5, score - len(issues) * 0.6)
    return {
        "chapter_id": chapter_num,
        "overall": "基本符合蓝图节奏要求" if not issues else "存在需要调整的节奏问题",
        "issues": issues,
        "suggestions": ["优先处理高优先级 must_include 缺失", "强化 emotional_curve 转折"],
        "score": round(score, 1),
    }


def save_pacing_report(project_dir: Path, chapter_num: int, report: dict) -> Path:
    reports_dir = _get_report_dir(project_dir)
    reports_dir.mkdir(parents=True, exist_ok=True)
    path = reports_dir / f"chapter_{chapter_num:03d}_pacing_report.md"
    lines = [
        f"# 第{chapter_num}章节奏检查报告\n",
        f"## 总体评价\n{report['overall']}\n",
        f"评分：{report.get('score', 7.0)}\n",
        "## 问题列表\n",
    ]
    for idx, iss in enumerate(report.get("issues", []), 1):
        lines.append(f"### {idx}. scene_{iss.get('scene',0)} - {iss['issue']}")
        lines.append(f"建议：{iss.get('suggestion','')}\n")
    lines.append("## 修改建议\n")
    for sug in report.get("suggestions", []):
        lines.append(f"- {sug}")
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def parse_chapter_request(user_request: str, default_chapter: int = 1, default_words: int = 2000) -> dict:
    """Parse user input for chapter requirements. Support numeric and chinese-ish."""
    req = {"chapter_num": default_chapter, "target_words": default_words, "raw": user_request}
    m = re.search(r"(?:第|chapter|ch)?\s*(\d{1,4})", user_request, re.I)
    if m:
        req["chapter_num"] = int(m.group(1))
    m = re.search(r"(\d{3,5})\s*字|目标字数[:：]\s*(\d+)", user_request)
    if m:
        req["target_words"] = int(m.group(1) or m.group(2))
    # title guess
    title_match = re.search(r"标题[:：]?\s*(.+?)(?:\n|目标|字数|第)", user_request)
    if title_match:
        req["title"] = title_match.group(1).strip()
    return req
