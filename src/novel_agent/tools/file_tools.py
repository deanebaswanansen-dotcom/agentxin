from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from novel_agent.mcp.tools import ensure_project_path
from novel_agent.providers.base import ToolDescriptor


class FileReadInput(BaseModel):
    path: str


class FileReadOutput(BaseModel):
    path: str
    content: str


class FileWriteInput(BaseModel):
    path: str
    content: str
    overwrite: bool = False


class FileWriteOutput(BaseModel):
    path: str
    bytes_written: int
    overwritten: bool


class FileReadTool:
    descriptor = ToolDescriptor(
        name="FileReadTool",
        purpose="Read a UTF-8 file inside project scope.",
        input_schema=FileReadInput.model_json_schema(),
        output_schema=FileReadOutput.model_json_schema(),
        error_types=["PATH_SECURITY_ERROR", "FILE_NOT_FOUND"],
    )

    def run(self, project_dir: Path, data: FileReadInput) -> FileReadOutput:
        path = ensure_project_path(project_dir, data.path)
        return FileReadOutput(path=str(path), content=path.read_text(encoding="utf-8"))


class FileWriteTool:
    descriptor = ToolDescriptor(
        name="FileWriteTool",
        purpose="Write a UTF-8 file inside project scope.",
        input_schema=FileWriteInput.model_json_schema(),
        output_schema=FileWriteOutput.model_json_schema(),
        side_effects=["write_file"],
        error_types=["PATH_SECURITY_ERROR", "FILE_EXISTS"],
        requires_confirmation=True,
    )

    def run(self, project_dir: Path, data: FileWriteInput) -> FileWriteOutput:
        path = ensure_project_path(project_dir, data.path)
        existed = path.exists()
        if existed and not data.overwrite:
            raise FileExistsError(f"File exists: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data.content, encoding="utf-8")
        return FileWriteOutput(path=str(path), bytes_written=len(data.content.encode("utf-8")), overwritten=existed)
