from __future__ import annotations

import json
import time
from collections.abc import Iterator
from typing import Any

import requests
from requests import Response

from novel_agent.config import AgentConfig, mask_secret
from novel_agent.providers.base import (
    CompletionChunk,
    CompletionOptions,
    CompletionResult,
    Message,
    ProviderError,
    ProviderPingResult,
)


class OpenAICompatibleProvider:
    provider_name = "openai-compatible"

    def __init__(self, config: AgentConfig):
        self.config = config

    def complete(self, messages: list[Message], options: CompletionOptions) -> CompletionResult:
        response = self._request(messages, options, stream=False)
        payload = self._parse_json(response)
        try:
            message = payload["choices"][0]["message"]
            text = message.get("content") or message.get("reasoning_content") or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("PARSE_ERROR", "返回结构不符合预期") from exc
        return CompletionResult(text=text, raw=payload)

    def stream(self, messages: list[Message], options: CompletionOptions) -> Iterator[CompletionChunk]:
        response = self._request(messages, options, stream=True)
        for line in response.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data: "):
                continue
            data = line.removeprefix("data: ").strip()
            if data == "[DONE]":
                break
            try:
                payload = json.loads(data)
                delta = payload["choices"][0]["delta"]
                text = delta.get("content") or delta.get("reasoning_content") or ""
            except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
                raise ProviderError("PARSE_ERROR", "流式返回结构不符合预期") from exc
            if text:
                yield CompletionChunk(text=text, raw=payload)

    def ping(self) -> ProviderPingResult:
        started = time.perf_counter()
        result = ProviderPingResult(
            provider=self.provider_name,
            base_url=self.config.base_url,
            model=self.config.model,
            api_key_masked=mask_secret(self.config.api_key),
        )
        api_key_val = self.config.api_key.get_secret_value()
        if not self.config.base_url or not api_key_val:
            result.error_type = "CONFIG_ERROR"
            result.error_message = "缺少 API Key 或 base_url"
            result.network = "FAILED"
            result.auth = "FAILED"
            result.chat_completion = "FAILED"
            result.latency_ms = int((time.perf_counter() - started) * 1000)
            return result
        try:
            self.complete(
                [
                    Message(role="system", content="Reply with exactly: pong"),
                    Message(role="user", content="ping"),
                ],
                CompletionOptions(
                    temperature=0,
                    max_tokens=min(32, self.config.max_tokens),
                    stream=False,
                ),
            )
            result.network = "OK"
            result.auth = "OK"
            result.chat_completion = "OK"
        except ProviderError as exc:
            et = exc.error_type or "UNKNOWN_ERROR"
            result.error_type = et
            result.error_message = str(exc)
            if et in {"NETWORK_ERROR", "CONFIG_ERROR"}:
                result.network = "FAILED"
            else:
                result.network = "OK"
            result.auth = "FAILED" if et == "AUTH_ERROR" else ("OK" if result.network == "OK" else "FAILED")
            result.chat_completion = "FAILED"
            if et == "RATE_LIMIT_ERROR":
                result.auth = "OK"
                result.chat_completion = "FAILED"
        except Exception as exc:
            result.network = "FAILED"
            result.auth = "FAILED"
            result.chat_completion = "FAILED"
            result.error_type = "UNKNOWN_ERROR"
            result.error_message = f"未知错误: {exc}"
        finally:
            result.latency_ms = int((time.perf_counter() - started) * 1000)
        return result

    def _request(self, messages: list[Message], options: CompletionOptions, stream: bool) -> Response:
        url = self.config.base_url.rstrip("/") + "/chat/completions"
        body = {
            "model": self.config.model,
            "messages": [message.model_dump() for message in messages],
            "temperature": options.temperature,
            "max_tokens": options.max_tokens,
            "stream": stream,
        }
        body.update(self.provider_request_extras())
        headers = {
            "Authorization": f"Bearer {self.config.api_key.get_secret_value()}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream else "application/json",
        }
        last_error: Exception | None = None
        for attempt in range(self.config.max_retries):
            try:
                response = requests.post(
                    url,
                    headers=headers,
                    json=body,
                    stream=stream,
                    timeout=self.config.timeout_seconds,
                )
                if response.ok:
                    return response
                raise self._http_error(response)
            except requests.Timeout as exc:
                last_error = exc
                if attempt + 1 >= self.config.max_retries:
                    raise ProviderError("NETWORK_ERROR", "DNS / 代理 / 超时") from exc
            except requests.RequestException as exc:
                last_error = exc
                if attempt + 1 >= self.config.max_retries:
                    raise ProviderError("NETWORK_ERROR", "DNS / 代理 / 超时") from exc
            except ProviderError:
                raise
        raise ProviderError("UNKNOWN_ERROR", str(last_error) if last_error else "未知错误")

    def provider_request_extras(self) -> dict[str, Any]:
        return {}

    def _parse_json(self, response: Response) -> dict[str, Any]:
        try:
            return response.json()
        except requests.JSONDecodeError as exc:
            raise ProviderError("PARSE_ERROR", "返回结构不符合预期") from exc

    def _http_error(self, response: Response) -> ProviderError:
        message = sanitize_response_text(response.text)
        if response.status_code in {401, 403}:
            return ProviderError("AUTH_ERROR", "Key 无效或权限不足", response.status_code)
        if response.status_code == 429:
            return ProviderError("RATE_LIMIT_ERROR", "限流", response.status_code)
        if response.status_code in {400, 404}:
            return ProviderError("MODEL_ERROR", f"模型名错误或模型不可用：{message}", response.status_code)
        if response.status_code >= 500:
            return ProviderError("PROVIDER_ERROR", f"服务端错误：{response.status_code}", response.status_code)
        return ProviderError("UNKNOWN_ERROR", f"未知错误：{response.status_code}", response.status_code)


def sanitize_response_text(text: str) -> str:
    cleaned = text.replace("Authorization", "[redacted-header]")
    if len(cleaned) > 300:
        return cleaned[:300]
    return cleaned
