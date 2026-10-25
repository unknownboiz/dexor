from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def parse_sse(body: str) -> list[dict]:
    events = []
    for block in body.replace("\r\n", "\n").split("\n\n"):
        data = "\n".join(
            line[5:].lstrip()
            for line in block.split("\n")
            if line.startswith("data:")
        )
        if data:
            events.append(json.loads(data))
    return events


def test_config_lists_providers() -> None:
    response = client.get("/api/config")
    assert response.status_code == 200
    data = response.json()
    assert data["app"] == "DexBot"
    assert data["default_provider"] == "demo"
    ids = {provider["id"] for provider in data["providers"]}
    assert {"xai", "openai", "anthropic", "google", "ollama", "demo"} <= ids
    demo = next(provider for provider in data["providers"] if provider["id"] == "demo")
    assert demo["available"] is True
    assert demo["image_models"] == ["demo-image"]


def test_demo_chat_streams() -> None:
    response = client.post(
        "/api/chat",
        json={
            "provider": "demo",
            "model": "demo-chat",
            "messages": [{"role": "user", "content": "Hello there"}],
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    events = parse_sse(response.text)
    kinds = [event["type"] for event in events]
    assert kinds[0] == "meta"
    assert "delta" in kinds
    assert kinds[-1] == "done"

    text = "".join(
        event["text"] for event in events if event["type"] == "delta"
    )
    assert "Demo mode" in text


def test_demo_chat_includes_markdown_code() -> None:
    response = client.post(
        "/api/chat",
        json={
            "provider": "demo",
            "model": "demo-chat",
            "messages": [
                {"role": "user", "content": "Write a Python script for me"}
            ],
        },
    )
    text = "".join(
        event["text"]
        for event in parse_sse(response.text)
        if event["type"] == "delta"
    )
    assert "```python" in text


def test_chat_validation() -> None:
    unknown = client.post(
        "/api/chat",
        json={
            "provider": "nope",
            "model": "demo-chat",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert unknown.status_code == 400

    unavailable = client.post(
        "/api/chat",
        json={
            "provider": "openai",
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert unavailable.status_code == 400
    assert "OPENAI_API_KEY" in unavailable.json()["detail"]

    no_user = client.post(
        "/api/chat",
        json={
            "provider": "demo",
            "model": "demo-chat",
            "messages": [{"role": "assistant", "content": "hi"}],
        },
    )
    assert no_user.status_code == 400

    last_assistant = client.post(
        "/api/chat",
        json={
            "provider": "demo",
            "model": "demo-chat",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
            ],
        },
    )
    assert last_assistant.status_code == 400


def test_demo_image_generation() -> None:
    response = client.post(
        "/api/images",
        json={
            "provider": "demo",
            "model": "demo-image",
            "prompt": "A tiny robot reading a book",
            "size": "1024x1024",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["url"].startswith("/media/")
    assert data["prompt"] == "A tiny robot reading a book"
    assert data["model"] == "demo-image"

    image = client.get(data["url"])
    assert image.status_code == 200
    assert image.headers["content-type"].startswith("image/svg+xml")
    assert b"<svg" in image.content


def test_image_validation() -> None:
    empty = client.post(
        "/api/images",
        json={
            "provider": "demo",
            "model": "demo-image",
            "prompt": "   ",
        },
    )
    assert empty.status_code == 400

    bad_size = client.post(
        "/api/images",
        json={
            "provider": "demo",
            "model": "demo-image",
            "prompt": "robot",
            "size": "huge",
        },
    )
    assert bad_size.status_code == 422


def test_health_and_frontend() -> None:
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    page = client.get("/")
    assert page.status_code == 200
    assert "DexBot" in page.text

    script = client.get("/static/app.js")
    assert script.status_code == 200
