from __future__ import annotations

import asyncio
import json

import pytest

from app import providers as providers_module
from app.config import Provider
from app.providers import ProviderError, stream_chat


class FakeResponse:
    def __init__(self, lines: list[str], status_code: int = 200, body: bytes = b""):
        self._lines = lines
        self.status_code = status_code
        self.reason_phrase = "OK" if status_code < 400 else "Unauthorized"
        self._body = body

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self) -> bytes:
        return self._body


class FakeStream:
    def __init__(self, response: FakeResponse):
        self.response = response

    async def __aenter__(self) -> FakeResponse:
        return self.response

    async def __aexit__(self, *args) -> None:
        return None


class FakeClient:
    calls: list[dict] = []
    response: FakeResponse = FakeResponse([])

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    def stream(self, method, url, headers=None, json=None):
        FakeClient.calls.append(
            {"method": method, "url": url, "headers": headers, "json": json}
        )
        return FakeStream(FakeClient.response)


def collect(coro):
    async def run():
        return [event async for event in coro]

    return asyncio.run(run())


def test_openai_stream(monkeypatch):
    monkeypatch.setenv("FAKE_KEY", "secret")
    monkeypatch.setattr(providers_module.httpx, "AsyncClient", FakeClient)
    FakeClient.calls = []
    FakeClient.response = FakeResponse(
        [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":" world"}}]}',
            "",
            "data: [DONE]",
        ]
    )
    provider = Provider(
        id="fake",
        label="Fake",
        kind="openai",
        base_url="https://fake.test/v1",
        key_env="FAKE_KEY",
        models=("fake-model",),
    )

    events = collect(
        stream_chat(
            provider,
            "fake-model",
            [{"role": "user", "content": "Hi"}],
            "Be brief",
            0.3,
            None,
        )
    )
    text = "".join(event["text"] for event in events if event["type"] == "text")
    assert text == "Hello world"

    call = FakeClient.calls[0]
    assert call["url"] == "https://fake.test/v1/chat/completions"
    assert call["headers"]["Authorization"] == "Bearer secret"
    assert call["json"]["messages"][0] == {"role": "system", "content": "Be brief"}
    assert call["json"]["stream"] is True
    assert call["json"]["temperature"] == 0.3


def test_anthropic_stream(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_KEY", "secret")
    monkeypatch.setattr(providers_module.httpx, "AsyncClient", FakeClient)
    FakeClient.calls = []
    FakeClient.response = FakeResponse(
        [
            "event: content_block_delta",
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude"}}',
            "",
            "event: message_stop",
            'data: {"type":"message_stop"}',
            "",
        ]
    )
    provider = Provider(
        id="claude",
        label="Claude",
        kind="anthropic",
        base_url="https://anthropic.test/v1",
        key_env="ANTHROPIC_KEY",
        models=("claude-test",),
    )

    events = collect(
        stream_chat(
            provider,
            "claude-test",
            [
                {"role": "system", "content": "Be nice"},
                {"role": "user", "content": "Hello"},
            ],
            None,
            None,
            256,
        )
    )
    text = "".join(event["text"] for event in events if event["type"] == "text")
    assert text == "Claude"

    call = FakeClient.calls[0]
    assert call["url"] == "https://anthropic.test/v1/messages"
    assert call["headers"]["x-api-key"] == "secret"
    assert call["headers"]["anthropic-version"] == "2023-06-01"
    assert call["json"]["system"] == "Be nice"
    assert call["json"]["max_tokens"] == 256


def test_google_stream(monkeypatch):
    monkeypatch.setenv("GOOGLE_KEY", "secret")
    monkeypatch.setattr(providers_module.httpx, "AsyncClient", FakeClient)
    FakeClient.calls = []
    FakeClient.response = FakeResponse(
        [
            'data: {"candidates":[{"content":{"parts":[{"text":"Gemini"}]}}]}',
            "",
            'data: {"candidates":[{"content":{"parts":[{"text":" here"}]}}]}',
            "",
        ]
    )
    provider = Provider(
        id="google",
        label="Google",
        kind="google",
        base_url="https://google.test/v1beta",
        key_env="GOOGLE_KEY",
        models=("gemini-test",),
    )

    events = collect(
        stream_chat(
            provider,
            "gemini-test",
            [{"role": "user", "content": "Hello"}],
            "Be short",
            None,
            None,
        )
    )
    text = "".join(event["text"] for event in events if event["type"] == "text")
    assert text == "Gemini here"

    call = FakeClient.calls[0]
    assert "models/gemini-test:streamGenerateContent?alt=sse" in call["url"]
    assert call["headers"]["x-goog-api-key"] == "secret"
    assert call["json"]["systemInstruction"]["parts"][0]["text"] == "Be short"


def test_openai_error_is_readable(monkeypatch):
    monkeypatch.setenv("FAKE_KEY", "secret")
    monkeypatch.setattr(providers_module.httpx, "AsyncClient", FakeClient)
    FakeClient.response = FakeResponse(
        [],
        status_code=401,
        body=json.dumps({"error": {"message": "Invalid API key"}}).encode(),
    )
    provider = Provider(
        id="fake",
        label="Fake",
        kind="openai",
        base_url="https://fake.test/v1",
        key_env="FAKE_KEY",
        models=("fake-model",),
    )

    with pytest.raises(ProviderError) as error:
        collect(
            stream_chat(
                provider,
                "fake-model",
                [{"role": "user", "content": "Hi"}],
                None,
                None,
                None,
            )
        )
    assert "Invalid API key" in str(error.value)
    assert error.value.status == 401
