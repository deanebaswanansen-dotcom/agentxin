from __future__ import annotations

from collections.abc import Iterator
from typing import Protocol

from pydantic import BaseModel, Field


class Message(BaseModel):
    role: str
    content: str


class CompletionOptions(BaseModel):
    temperature: float = 0.75
    max_tokens: int = 4096
    stream: bool = True


class CompletionResult(BaseModel):
    text: str
    raw: dict | None = None


class CompletionChunk(BaseModel):
    text: str
    raw: dict | None = None


class ProviderPingResult(BaseModel):
    provider: str
    base_url: str
    model: str
    api_key_masked: str
    network: str = "FAILED"
    auth: str = "FAILED"
    chat_completion: str = "FAILED"
    latency_ms: int | None = None
    error_type: str | None = None
    error_message: str | None = None

    @property
    def ok(self) -> bool:
        return self.network == "OK" and self.auth == "OK" and self.chat_completion == "OK"


class LLMProvider(Protocol):
    def complete(self, messages: list[Message], options: CompletionOptions) -> CompletionResult:
        ...

    def stream(self, messages: list[Message], options: CompletionOptions) -> Iterator[CompletionChunk]:
        ...

    def ping(self) -> ProviderPingResult:
        ...


class ProviderError(Exception):
    def __init__(self, error_type: str, message: str, status_code: int | None = None):
        super().__init__(message)
        self.error_type = error_type
        self.status_code = status_code


ERROR_TYPES = {
    "CONFIG_ERROR",
    "AUTH_ERROR",
    "NETWORK_ERROR",
    "MODEL_ERROR",
    "RATE_LIMIT_ERROR",
    "PROVIDER_ERROR",
    "PARSE_ERROR",
    "UNKNOWN_ERROR",
}


class ToolDescriptor(BaseModel):
    name: str
    purpose: str
    input_schema: dict = Field(default_factory=dict)
    output_schema: dict = Field(default_factory=dict)
    side_effects: list[str] = Field(default_factory=list)
    error_types: list[str] = Field(default_factory=list)
    requires_confirmation: bool = False
