from __future__ import annotations

from pydantic import BaseModel, Field


class MCPToolSpec(BaseModel):
    name: str
    purpose: str
    input_schema: dict = Field(default_factory=dict)
    output_schema: dict = Field(default_factory=dict)
    side_effects: list[str] = Field(default_factory=list)
    error_types: list[str] = Field(default_factory=list)
    requires_confirmation: bool = False


class MCPResourceSpec(BaseModel):
    uri: str
    purpose: str


class MCPPromptSpec(BaseModel):
    name: str
    purpose: str


class NovelMCPManifest(BaseModel):
    name: str = "novel-agent-mcp"
    version: str = "0.1.0"
    tools: list[MCPToolSpec]
    resources: list[MCPResourceSpec]
    prompts: list[MCPPromptSpec]


def build_manifest() -> NovelMCPManifest:
    tools = [
        "novel.project.load",
        "novel.context.build",
        "novel.chapter.read",
        "novel.chapter.write",
        "novel.memory.search",
        "novel.memory.update",
        "novel.review.run",
        "novel.export.markdown",
    ]
    resources = [
        "novel://project/bible",
        "novel://project/characters",
        "novel://project/world",
        "novel://project/chapters",
        "novel://project/memory",
    ]
    prompts = [
        "novel.write_chapter",
        "novel.review_chapter",
        "novel.revise_chapter",
        "novel.summarize_chapter",
    ]
    return NovelMCPManifest(
        tools=[
            MCPToolSpec(
                name=name,
                purpose=f"Expose {name} through a project-scoped MCP interface.",
                input_schema={"type": "object"},
                output_schema={"type": "object"},
                side_effects=["project_files"] if name.endswith(("write", "update", "markdown")) else [],
                error_types=["PATH_SECURITY_ERROR", "VALIDATION_ERROR"],
                requires_confirmation=name.endswith("write"),
            )
            for name in tools
        ],
        resources=[MCPResourceSpec(uri=uri, purpose=f"Read {uri} inside project scope.") for uri in resources],
        prompts=[MCPPromptSpec(name=name, purpose=f"Prompt template for {name}.") for name in prompts],
    )
