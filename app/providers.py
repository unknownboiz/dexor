from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
import os
import re
import textwrap
import uuid
from datetime import datetime, timezone
from typing import AsyncIterator

import httpx

from .config import Provider, ensure_media_dir

logger = logging.getLogger("dexbot.providers")

MAX_IMAGE_BYTES = 25 * 1024 * 1024
_IMAGE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
}


class ProviderError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def _timeout() -> httpx.Timeout:
    read = float(os.getenv("DEXBOT_READ_TIMEOUT", "300"))
    return httpx.Timeout(connect=20.0, read=read, write=60.0, pool=20.0)


def _url(provider: Provider, path: str) -> str:
    return provider.base_url.rstrip("/") + path


def _headers(provider: Provider) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "DexBot/1.0",
    }
    key = provider.api_key
    if key:
        headers["Authorization"] = f"Bearer {key}"
    headers.update(dict(provider.headers))
    return headers


async def _http_error(response: httpx.Response) -> ProviderError:
    raw = await response.aread()
    text = raw.decode("utf-8", "replace").strip()
    message = ""
    try:
        payload = json.loads(text)
        error = payload.get("error", payload) if isinstance(payload, dict) else payload
        if isinstance(error, dict):
            message = str(error.get("message") or error.get("detail") or "")
        elif isinstance(error, str):
            message = error
    except (json.JSONDecodeError, TypeError):
        pass

    if not message:
        message = text[:600] or response.reason_phrase
    return ProviderError(
        f"{response.status_code} {response.reason_phrase}: {message}"[:900],
        status=response.status_code,
    )


def _extract_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def _normalize_messages(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for message in messages:
        role = message.get("role")
        content = (message.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n\n" + content
        else:
            out.append({"role": role, "content": content})
    return out


async def stream_chat(
    provider: Provider,
    model: str,
    messages: list[dict],
    system: str | None,
    temperature: float | None,
    max_tokens: int | None,
) -> AsyncIterator[dict]:
    if provider.kind == "demo":
        async for event in _stream_demo(messages):
            yield event
    elif provider.kind == "openai":
        async for event in _stream_openai(
            provider, model, messages, system, temperature, max_tokens
        ):
            yield event
    elif provider.kind == "anthropic":
        async for event in _stream_anthropic(
            provider, model, messages, system, temperature, max_tokens
        ):
            yield event
    elif provider.kind == "google":
        async for event in _stream_google(
            provider, model, messages, system, temperature, max_tokens
        ):
            yield event
    else:
        raise ProviderError(f"Unsupported provider type: {provider.kind}")


async def _stream_openai(
    provider: Provider,
    model: str,
    messages: list[dict],
    system: str | None,
    temperature: float | None,
    max_tokens: int | None,
) -> AsyncIterator[dict]:
    payload: dict = {
        "model": model,
        "messages": _normalize_messages(messages),
        "stream": True,
    }
    if system:
        payload["messages"] = [
            {"role": "system", "content": system},
            *payload["messages"],
        ]
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens

    headers = _headers(provider)
    headers["Accept"] = "text/event-stream"

    async with httpx.AsyncClient(timeout=_timeout()) as client:
        async with client.stream(
            "POST", _url(provider, "/chat/completions"), headers=headers, json=payload
        ) as response:
            if response.status_code >= 400:
                raise await _http_error(response)

            async for line in response.aiter_lines():
                line = line.strip()
                if not line or line.startswith(":") or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if not isinstance(chunk, dict):
                    continue
                if chunk.get("error"):
                    error = chunk["error"]
                    message = (
                        error.get("message") if isinstance(error, dict) else str(error)
                    )
                    raise ProviderError(str(message or "Provider returned an error"))

                text = ""
                for choice in chunk.get("choices") or []:
                    if not isinstance(choice, dict):
                        continue
                    delta = choice.get("delta") or {}
                    text += _extract_text(delta.get("content"))
                if text:
                    yield {"type": "text", "text": text}
                if chunk.get("usage"):
                    yield {"type": "usage", "usage": chunk["usage"]}

    yield {"type": "usage", "usage": {}}


async def _stream_anthropic(
    provider: Provider,
    model: str,
    messages: list[dict],
    system: str | None,
    temperature: float | None,
    max_tokens: int | None,
) -> AsyncIterator[dict]:
    system_parts = [system.strip()] if system and system.strip() else []
    chat_messages: list[dict] = []
    for message in messages:
        role = message.get("role")
        content = (message.get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            system_parts.append(content)
        elif role in {"user", "assistant"}:
            chat_messages.append({"role": role, "content": content})

    chat_messages = _normalize_messages(chat_messages)
    if not chat_messages:
        raise ProviderError("No messages to send")
    if chat_messages[0]["role"] != "user":
        chat_messages.insert(0, {"role": "user", "content": "Continue."})

    payload: dict = {
        "model": model,
        "max_tokens": int(max_tokens or os.getenv("ANTHROPIC_MAX_TOKENS", "8192")),
        "messages": chat_messages,
        "stream": True,
    }
    if system_parts:
        payload["system"] = "\n\n".join(system_parts)
    if temperature is not None:
        payload["temperature"] = min(max(temperature, 0.0), 1.0)

    headers = _headers(provider)
    headers.pop("Authorization", None)
    headers["x-api-key"] = provider.api_key
    headers["anthropic-version"] = "2023-06-01"

    async with httpx.AsyncClient(timeout=_timeout()) as client:
        async with client.stream(
            "POST", _url(provider, "/messages"), headers=headers, json=payload
        ) as response:
            if response.status_code >= 400:
                raise await _http_error(response)

            async for line in response.aiter_lines():
                line = line.strip()
                if not line or line.startswith(":") or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue

                event_type = event.get("type")
                if event_type == "content_block_delta":
                    delta = event.get("delta") or {}
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        yield {"type": "text", "text": delta["text"]}
                elif event_type == "content_block_start":
                    block = event.get("content_block") or {}
                    if block.get("type") == "text" and block.get("text"):
                        yield {"type": "text", "text": block["text"]}
                elif event_type == "message_delta":
                    usage = event.get("usage") or {}
                    if usage:
                        yield {"type": "usage", "usage": usage}
                elif event_type == "error":
                    error = event.get("error") or {}
                    raise ProviderError(
                        str(error.get("message") or "Anthropic returned an error")
                    )

    yield {"type": "usage", "usage": {}}


async def _stream_google(
    provider: Provider,
    model: str,
    messages: list[dict],
    system: str | None,
    temperature: float | None,
    max_tokens: int | None,
) -> AsyncIterator[dict]:
    contents = []
    for message in messages:
        role = message.get("role")
        content = (message.get("content") or "").strip()
        if role not in {"user", "assistant", "model"} or not content:
            continue
        mapped = "model" if role in {"assistant", "model"} else "user"
        if contents and contents[-1]["role"] == mapped:
            contents[-1]["parts"][0]["text"] += "\n\n" + content
        else:
            contents.append({"role": mapped, "parts": [{"text": content}]})

    if not contents:
        raise ProviderError("No messages to send")
    if contents[0]["role"] != "user":
        contents.insert(0, {"role": "user", "parts": [{"text": "Continue."}]})

    payload: dict = {"contents": contents}
    if system and system.strip():
        payload["systemInstruction"] = {"parts": [{"text": system.strip()}]}
    generation: dict = {}
    if temperature is not None:
        generation["temperature"] = min(max(temperature, 0.0), 2.0)
    if max_tokens is not None:
        generation["maxOutputTokens"] = max_tokens
    if generation:
        payload["generationConfig"] = generation

    model_name = model.removeprefix("models/")
    url = _url(provider, f"/models/{model_name}:streamGenerateContent?alt=sse")
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "x-goog-api-key": provider.api_key,
        "User-Agent": "DexBot/1.0",
    }

    async with httpx.AsyncClient(timeout=_timeout()) as client:
        async with client.stream(
            "POST", url, headers=headers, json=payload
        ) as response:
            if response.status_code >= 400:
                raise await _http_error(response)

            async for line in response.aiter_lines():
                line = line.strip()
                if not line or line.startswith(":") or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get("error"):
                    error = event["error"]
                    message = (
                        error.get("message") if isinstance(error, dict) else str(error)
                    )
                    raise ProviderError(str(message or "Gemini returned an error"))

                text = ""
                for candidate in event.get("candidates") or []:
                    content = candidate.get("content") or {}
                    for part in content.get("parts") or []:
                        if isinstance(part, dict) and not part.get("thought"):
                            text += part.get("text") or ""
                if text:
                    yield {"type": "text", "text": text}

                usage = event.get("usageMetadata")
                if usage:
                    yield {
                        "type": "usage",
                        "usage": {
                            "input_tokens": usage.get("promptTokenCount"),
                            "output_tokens": usage.get("candidatesTokenCount"),
                            "total_tokens": usage.get("totalTokenCount"),
                        },
                    }

    yield {"type": "usage", "usage": {}}


def _demo_reply(messages: list[dict]) -> str:
    prompt = ""
    for message in reversed(messages):
        if message.get("role") == "user" and (message.get("content") or "").strip():
            prompt = message["content"].strip()
            break

    short = prompt.replace("\n", " ")[:240]
    if any(word in prompt.lower() for word in ("code", "python", "function", "script")):
        sample = textwrap.dedent(
            '''\
            ```python
            from pathlib import Path

            def rename_files(folder: str, prefix: str = "file") -> None:
                for index, path in enumerate(Path(folder).iterdir(), start=1):
                    if path.is_file():
                        target = path.with_name(f"{prefix}_{index:03d}{path.suffix}")
                        path.rename(target)

            rename_files("./downloads", prefix="photo")
            ```
            '''
        )
        return (
            "**Demo mode** — no API key is configured yet, so this reply is generated "
            "locally.\n\n"
            f'You asked: _"{short}"_\n\n'
            "Here is a small example of the kind of response DexBot can stream:\n\n"
            f"{sample}\n"
            "To get real answers, add a key such as `XAI_API_KEY` or `OPENAI_API_KEY` "
            "to the `.env` file and restart the server. You can switch providers and "
            "models from the picker in the top bar.\n\n"
            "> Tip: image mode uses the same provider switch — try the `demo-image` "
            "model to see the image flow without a key."
        )

    return (
        "**Demo mode** — I'm running locally because no provider key is configured.\n\n"
        f'You said: _"{short}"_\n\n'
        "This is a mock response, but everything around it is real: the streaming "
        "transport, markdown rendering, conversation history, model switching, and "
        "image generation.\n\n"
        "### Make it live\n"
        "1. Copy `.env.example` to `.env`\n"
        "2. Add `XAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or "
        "`GOOGLE_API_KEY`\n"
        "3. Restart `uvicorn` and pick that provider in the top bar\n\n"
        "You can also point DexBot at a local model with **Ollama** — no key needed."
    )


async def _stream_demo(messages: list[dict]) -> AsyncIterator[dict]:
    delay = float(os.getenv("DEMO_DELAY", "0.012"))
    reply = _demo_reply(messages)
    words = reply.split(" ")
    chunk: list[str] = []
    for index, word in enumerate(words):
        chunk.append(word)
        if len(chunk) >= 3 or index == len(words) - 1:
            text = " ".join(chunk)
            if index != len(words) - 1:
                text += " "
            yield {"type": "text", "text": text}
            chunk = []
            if delay > 0:
                await asyncio.sleep(delay)
    yield {"type": "usage", "usage": {}}


def _sniff_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    head = data[:400].lstrip().lower()
    if head.startswith(b"<svg") or b"<svg" in head:
        return "image/svg+xml"
    return None


def _save_image(data: bytes, mime: str, allow_svg: bool = False) -> str:
    if not data:
        raise ProviderError("The provider returned an empty image")
    if len(data) > MAX_IMAGE_BYTES:
        raise ProviderError("Generated image is too large (max 25 MB)")

    mime = (mime or "").split(";")[0].strip().lower()
    if not mime.startswith("image/"):
        mime = _sniff_mime(data) or ""
    if not mime.startswith("image/"):
        raise ProviderError("The provider returned an unsupported image format")
    if mime == "image/svg+xml" and not allow_svg:
        raise ProviderError("SVG responses are not accepted from providers")

    extension = _IMAGE_EXT.get(mime)
    if not extension:
        raise ProviderError(f"Unsupported image type: {mime}")

    directory = ensure_media_dir()
    name = f"{uuid.uuid4().hex}{extension}"
    (directory / name).write_bytes(data)
    return f"/media/{name}"


async def _openai_image(
    provider: Provider, model: str, prompt: str, size: str | None
) -> dict:
    payload: dict = {"model": model, "prompt": prompt, "n": 1}
    if size:
        payload["size"] = size

    headers = _headers(provider)
    headers["Accept"] = "application/json"

    async with httpx.AsyncClient(timeout=_timeout()) as client:
        response: httpx.Response | None = None
        for attempt in range(2):
            response = await client.post(
                _url(provider, "/images/generations"), headers=headers, json=payload
            )
            if (
                response.status_code in (400, 422)
                and "size" in payload
                and attempt == 0
            ):
                payload.pop("size", None)
                continue
            break

        if response is None:
            raise ProviderError("Image request failed")
        if response.status_code >= 400:
            raise await _http_error(response)

        try:
            body = response.json()
        except json.JSONDecodeError as exc:
            raise ProviderError("Provider returned invalid image JSON") from exc

        items = body.get("data") if isinstance(body, dict) else None
        if not isinstance(items, list) or not items:
            raise ProviderError("Provider returned no image data")
        item = items[0] if isinstance(items[0], dict) else {}

        encoded = item.get("b64_json") or item.get("b64") or item.get("base64")
        if encoded:
            try:
                data = base64.b64decode(encoded)
            except (ValueError, TypeError) as exc:
                raise ProviderError("Provider returned invalid image data") from exc
            mime = _sniff_mime(data) or "image/png"
            url = _save_image(data, mime)
        elif item.get("url"):
            image_response = await client.get(str(item["url"]))
            if image_response.status_code >= 400:
                raise ProviderError("Could not download the generated image")
            if len(image_response.content) > MAX_IMAGE_BYTES:
                raise ProviderError("Generated image is too large (max 25 MB)")
            mime = image_response.headers.get("content-type", "")
            url = _save_image(image_response.content, mime)
        else:
            raise ProviderError("Provider did not return an image URL or data")

        return {
            "url": url,
            "prompt": prompt,
            "revised_prompt": item.get("revised_prompt"),
            "provider": provider.id,
            "model": model,
        }


async def _google_image(
    provider: Provider, model: str, prompt: str, size: str | None
) -> dict:
    model_name = model.removeprefix("models/")
    url = _url(provider, f"/models/{model_name}:predict")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-goog-api-key": provider.api_key,
        "User-Agent": "DexBot/1.0",
    }
    payload = {
        "instances": [{"prompt": prompt}],
        "parameters": {"sampleCount": 1},
    }
    if size:
        width, _, height = size.partition("x")
        try:
            ratio = int(width) / int(height)
        except (ValueError, ZeroDivisionError):
            ratio = 1.0
        if ratio > 1.2:
            payload["parameters"]["aspectRatio"] = "16:9"
        elif ratio < 0.83:
            payload["parameters"]["aspectRatio"] = "9:16"

    async with httpx.AsyncClient(timeout=_timeout()) as client:
        response = await client.post(url, headers=headers, json=payload)
        if response.status_code >= 400:
            raise await _http_error(response)
        try:
            body = response.json()
        except json.JSONDecodeError as exc:
            raise ProviderError("Provider returned invalid image JSON") from exc

        predictions = body.get("predictions") if isinstance(body, dict) else None
        if not isinstance(predictions, list) or not predictions:
            raise ProviderError("Provider returned no image data")
        item = predictions[0] if isinstance(predictions[0], dict) else {}
        if item.get("raiFilteredReason"):
            raise ProviderError(str(item["raiFilteredReason"]))
        encoded = item.get("bytesBase64Encoded") or item.get("b64_json")
        if not encoded:
            raise ProviderError("Provider did not return image data")
        try:
            data = base64.b64decode(encoded)
        except (ValueError, TypeError) as exc:
            raise ProviderError("Provider returned invalid image data") from exc

        mime = item.get("mimeType") or _sniff_mime(data) or "image/png"
        return {
            "url": _save_image(data, mime),
            "prompt": prompt,
            "provider": provider.id,
            "model": model,
        }


def _demo_image(prompt: str) -> dict:
    digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    hue_a = int(digest[0:4], 16) % 360
    hue_b = (hue_a + 80 + int(digest[4:8], 16) % 120) % 360
    hue_c = (hue_b + 70) % 360

    wrapped = textwrap.wrap(prompt, width=42)[:6] or ["Your imagination goes here"]
    lines = "".join(
        f'<text x="512" y="{640 + i * 46}" text-anchor="middle" '
        f'font-family="Inter, Arial, sans-serif" font-size="30" '
        f'fill="rgba(255,255,255,0.92)">{html.escape(line)}</text>'
        for i, line in enumerate(wrapped)
    )
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl({hue_a}, 72%, 18%)"/>
      <stop offset="55%" stop-color="hsl({hue_b}, 70%, 32%)"/>
      <stop offset="100%" stop-color="hsl({hue_c}, 68%, 12%)"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="38%" r="55%">
      <stop offset="0%" stop-color="hsl({hue_b}, 95%, 72%)" stop-opacity="0.75"/>
      <stop offset="60%" stop-color="hsl({hue_a}, 90%, 45%)" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="black" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="46"/></filter>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <circle cx="512" cy="390" r="330" fill="url(#glow)"/>
  <g filter="url(#blur)" opacity="0.55">
    <circle cx="260" cy="250" r="120" fill="hsl({hue_c}, 90%, 60%)"/>
    <circle cx="790" cy="330" r="150" fill="hsl({hue_b}, 90%, 65%)"/>
  </g>
  <g fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2">
    <circle cx="512" cy="390" r="210"/>
    <circle cx="512" cy="390" r="280"/>
    <circle cx="512" cy="390" r="340"/>
  </g>
  <text x="512" y="378" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="76" font-weight="700" fill="white">DEMO</text>
  <text x="512" y="428" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" letter-spacing="8" fill="rgba(255,255,255,0.75)">DEXBOT IMAGE</text>
  {lines}
  <text x="512" y="938" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="20" fill="rgba(255,255,255,0.5)">Add an image-capable provider key for real generations</text>
</svg>"""
    return {
        "url": _save_image(svg.encode("utf-8"), "image/svg+xml", allow_svg=True),
        "prompt": prompt,
        "provider": "demo",
        "model": "demo-image",
    }


async def generate_image(
    provider: Provider, model: str, prompt: str, size: str | None
) -> dict:
    if provider.kind == "demo":
        await asyncio.sleep(float(os.getenv("DEMO_IMAGE_DELAY", "0.4")))
        result = _demo_image(prompt)
        result["created_at"] = datetime.now(timezone.utc).isoformat()
        return result

    if provider.kind == "google":
        result = await _google_image(provider, model, prompt, size)
    else:
        result = await _openai_image(provider, model, prompt, size)
    result["created_at"] = datetime.now(timezone.utc).isoformat()
    return result
