from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .config import (
    BASE_DIR,
    PROVIDERS,
    PROVIDER_MAP,
    Provider,
    default_provider,
    ensure_media_dir,
    media_dir,
)
from .providers import ProviderError, generate_image, stream_chat

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("dexbot")

STATIC_DIR = BASE_DIR / "static"
_ollama_probe = {"checked": 0.0, "available": False}
MODEL_RE = re.compile(r"^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$")
SIZE_RE = re.compile(r"^[1-9][0-9]{1,3}x[1-9][0-9]{1,3}$")
MAX_TOTAL_CHARS = 240_000


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_media_dir()
    logger.info("DexBot ready — data dir: %s", media_dir().parent)
    yield


app = FastAPI(title="DexBot", version="1.0.0", lifespan=lifespan)
ensure_media_dir()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/media", StaticFiles(directory=media_dir()), name="media")


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(default="", max_length=50_000)


class ChatRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=40)
    model: str = Field(min_length=1, max_length=120)
    messages: list[ChatMessage] = Field(min_length=1, max_length=200)
    system: str | None = Field(default=None, max_length=20_000)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=32_000)

    @field_validator("model")
    @classmethod
    def valid_model(cls, value: str) -> str:
        value = value.strip()
        if not MODEL_RE.match(value):
            raise ValueError("Invalid model name")
        return value


class ImageRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=40)
    model: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=4_000)
    size: str | None = Field(default=None, max_length=9)

    @field_validator("model")
    @classmethod
    def valid_model(cls, value: str) -> str:
        value = value.strip()
        if not MODEL_RE.match(value):
            raise ValueError("Invalid model name")
        return value

    @field_validator("size")
    @classmethod
    def valid_size(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return None
        if not SIZE_RE.match(value):
            raise ValueError("Size must look like 1024x1024")
        return value


def _get_provider(provider_id: str) -> Provider:
    provider = PROVIDER_MAP.get(provider_id)
    if not provider:
        raise HTTPException(status_code=400, detail="Unknown provider")
    if not provider.available:
        hint = f" Add {provider.key_env} to your .env." if provider.key_env else ""
        raise HTTPException(
            status_code=400,
            detail=f"{provider.label} is not configured.{hint}",
        )
    return provider


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.svg", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon.svg")


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


async def _ollama_available(provider: Provider) -> bool:
    if os.getenv("DEXBOT_CHECK_OLLAMA", "1") == "0":
        return True
    now = time.monotonic()
    if now - _ollama_probe["checked"] > 15:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(0.7)) as client:
                response = await client.get(
                    provider.base_url.rstrip("/") + "/models"
                )
                _ollama_probe["available"] = response.status_code < 500
        except (httpx.HTTPError, OSError):
            _ollama_probe["available"] = False
        _ollama_probe["checked"] = now
    return _ollama_probe["available"]


@app.get("/api/config")
async def config() -> dict:
    public = []
    for provider in PROVIDERS:
        data = provider.public_dict()
        if provider.id == "ollama" and data["available"]:
            data["available"] = await _ollama_available(provider)
        public.append(data)

    available = [provider["id"] for provider in public if provider["available"]]
    default = default_provider()
    if default.id not in available:
        fallback = next(
            (
                provider
                for provider in PROVIDERS
                if provider.available and provider.id in available
            ),
            PROVIDER_MAP["demo"],
        )
        default = fallback

    return {
        "app": "DexBot",
        "version": "1.0.0",
        "providers": public,
        "available": available,
        "default_provider": default.id,
        "default_model": default.default_model,
        "max_message_chars": 50_000,
        "max_total_chars": MAX_TOTAL_CHARS,
    }


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    provider = _get_provider(request.provider)

    messages = [
        {"role": message.role, "content": message.content}
        for message in request.messages
    ]
    total = sum(len(message["content"]) for message in messages) + len(
        request.system or ""
    )
    if total > MAX_TOTAL_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"Conversation is too long ({total} chars). Start a new chat.",
        )
    if not any(
        message["role"] == "user" and message["content"].strip()
        for message in messages
    ):
        raise HTTPException(
            status_code=400, detail="At least one non-empty user message is required"
        )
    if messages[-1]["role"] != "user":
        raise HTTPException(
            status_code=400, detail="The last message must come from the user"
        )

    async def event_stream():
        yield _sse(
            {
                "type": "meta",
                "provider": provider.id,
                "model": request.model,
                "created": datetime.now(timezone.utc).isoformat(),
            }
        )
        try:
            async for event in stream_chat(
                provider=provider,
                model=request.model,
                messages=messages,
                system=(request.system or "").strip() or None,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
            ):
                if event["type"] == "text" and event.get("text"):
                    yield _sse({"type": "delta", "text": event["text"]})
                elif event["type"] == "usage" and event.get("usage"):
                    yield _sse({"type": "usage", "usage": event["usage"]})
        except asyncio.CancelledError:
            raise
        except ProviderError as exc:
            logger.warning("Provider %s error: %s", provider.id, exc)
            yield _sse({"type": "error", "message": str(exc)})
        except httpx.TimeoutException:
            yield _sse(
                {
                    "type": "error",
                    "message": "The provider timed out. Try again or pick another model.",
                }
            )
        except httpx.HTTPError as exc:
            logger.warning("HTTP error from %s: %s", provider.id, exc)
            yield _sse(
                {
                    "type": "error",
                    "message": f"Could not reach {provider.label}. Check your connection.",
                }
            )
        except Exception:
            logger.exception("Unexpected error while streaming from %s", provider.id)
            yield _sse(
                {
                    "type": "error",
                    "message": "Something went wrong while generating a response.",
                }
            )
        yield _sse(
            {
                "type": "done",
                "time": datetime.now(timezone.utc).isoformat(),
            }
        )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/images")
async def images(request: ImageRequest) -> dict:
    provider = _get_provider(request.provider)
    if not provider.image_models and provider.kind != "demo":
        raise HTTPException(
            status_code=400,
            detail=f"{provider.label} does not have an image model configured.",
        )

    prompt = request.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Image prompt cannot be empty")

    started = time.perf_counter()
    try:
        result = await generate_image(
            provider=provider,
            model=request.model,
            prompt=prompt,
            size=request.size,
        )
    except ProviderError as exc:
        logger.warning("Image provider %s error: %s", provider.id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504, detail="Image generation timed out"
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning("Image HTTP error from %s: %s", provider.id, exc)
        raise HTTPException(
            status_code=502, detail=f"Could not reach {provider.label}"
        ) from exc

    result["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
    return result


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    if request.url.path == "/":
        response.headers.setdefault("Cache-Control", "no-store")
    elif request.url.path.startswith("/static/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response
