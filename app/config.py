from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

logger = logging.getLogger("dexbot.config")

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")


def _env_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    values = tuple(item.strip() for item in raw.split(",") if item.strip())
    return values or default


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    kind: str
    base_url: str
    key_env: str | None
    models: tuple[str, ...]
    image_models: tuple[str, ...] = ()
    docs_url: str = ""
    tagline: str = ""
    requires_key: bool = True
    headers: tuple[tuple[str, str], ...] = field(default_factory=tuple)

    @property
    def api_key(self) -> str:
        return os.getenv(self.key_env, "").strip() if self.key_env else ""

    @property
    def available(self) -> bool:
        if self.kind == "demo":
            return True
        if not self.requires_key:
            return True
        return bool(self.api_key)

    @property
    def default_model(self) -> str:
        return self.models[0] if self.models else ""

    @property
    def default_image_model(self) -> str:
        return self.image_models[0] if self.image_models else ""

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "tagline": self.tagline,
            "models": list(self.models),
            "image_models": list(self.image_models),
            "available": self.available,
            "requires_key": self.requires_key,
            "key_env": self.key_env,
            "docs_url": self.docs_url,
            "default_model": self.default_model,
            "default_image_model": self.default_image_model,
        }


PROVIDERS: list[Provider] = [
    Provider(
        id="xai",
        label="xAI Grok",
        kind="openai",
        base_url="https://api.x.ai/v1",
        key_env="XAI_API_KEY",
        models=_env_list("XAI_MODELS", ("grok-4", "grok-3", "grok-3-mini")),
        image_models=_env_list("XAI_IMAGE_MODELS", ("grok-2-image", "grok-2-image-1212")),
        docs_url="https://console.x.ai",
        tagline="Grok models from xAI",
    ),
    Provider(
        id="openai",
        label="OpenAI",
        kind="openai",
        base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        key_env="OPENAI_API_KEY",
        models=_env_list(
            "OPENAI_MODELS",
            ("gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"),
        ),
        image_models=_env_list("OPENAI_IMAGE_MODELS", ("gpt-image-1", "dall-e-3")),
        docs_url="https://platform.openai.com/api-keys",
        tagline="GPT models and image generation",
    ),
    Provider(
        id="anthropic",
        label="Anthropic",
        kind="anthropic",
        base_url=os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1"),
        key_env="ANTHROPIC_API_KEY",
        models=_env_list(
            "ANTHROPIC_MODELS",
            (
                "claude-sonnet-4-5",
                "claude-opus-4-1",
                "claude-haiku-4-5",
            ),
        ),
        docs_url="https://console.anthropic.com/settings/keys",
        tagline="Claude models",
    ),
    Provider(
        id="google",
        label="Google Gemini",
        kind="google",
        base_url=os.getenv(
            "GOOGLE_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"
        ),
        key_env="GOOGLE_API_KEY",
        models=_env_list(
            "GOOGLE_MODELS",
            ("gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"),
        ),
        image_models=_env_list(
            "GOOGLE_IMAGE_MODELS",
            ("imagen-4.0-generate-001", "imagen-3.0-generate-002"),
        ),
        docs_url="https://aistudio.google.com/apikey",
        tagline="Gemini and Imagen",
    ),
    Provider(
        id="groq",
        label="Groq",
        kind="openai",
        base_url="https://api.groq.com/openai/v1",
        key_env="GROQ_API_KEY",
        models=_env_list(
            "GROQ_MODELS",
            (
                "llama-3.3-70b-versatile",
                "llama-3.1-8b-instant",
                "openai/gpt-oss-120b",
            ),
        ),
        docs_url="https://console.groq.com/keys",
        tagline="Fast Llama and OSS models",
    ),
    Provider(
        id="openrouter",
        label="OpenRouter",
        kind="openai",
        base_url="https://openrouter.ai/api/v1",
        key_env="OPENROUTER_API_KEY",
        models=_env_list(
            "OPENROUTER_MODELS",
            (
                "x-ai/grok-4",
                "anthropic/claude-sonnet-4.5",
                "google/gemini-2.5-pro",
                "openai/gpt-4o",
                "deepseek/deepseek-chat-v3.1",
            ),
        ),
        docs_url="https://openrouter.ai/keys",
        tagline="One key, many models",
        headers=(
            ("HTTP-Referer", os.getenv("OPENROUTER_SITE_URL", "http://localhost")),
            ("X-Title", os.getenv("OPENROUTER_APP_NAME", "DexBot")),
        ),
    ),
    Provider(
        id="deepseek",
        label="DeepSeek",
        kind="openai",
        base_url="https://api.deepseek.com",
        key_env="DEEPSEEK_API_KEY",
        models=_env_list("DEEPSEEK_MODELS", ("deepseek-chat", "deepseek-reasoner")),
        docs_url="https://platform.deepseek.com/api_keys",
        tagline="DeepSeek chat and reasoning",
    ),
    Provider(
        id="mistral",
        label="Mistral",
        kind="openai",
        base_url="https://api.mistral.ai/v1",
        key_env="MISTRAL_API_KEY",
        models=_env_list(
            "MISTRAL_MODELS",
            ("mistral-large-latest", "mistral-small-latest", "codestral-latest"),
        ),
        docs_url="https://console.mistral.ai/api-keys",
        tagline="Mistral and Codestral",
    ),
    Provider(
        id="ollama",
        label="Ollama (local)",
        kind="openai",
        base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
        key_env=None,
        models=_env_list(
            "OLLAMA_MODELS",
            ("llama3.2", "qwen3", "mistral", "deepseek-r1:8b"),
        ),
        docs_url="https://ollama.com/download",
        tagline="Local models, no API key",
        requires_key=False,
    ),
    Provider(
        id="demo",
        label="Demo (no key)",
        kind="demo",
        base_url="",
        key_env=None,
        models=_env_list("DEMO_MODELS", ("demo-chat",)),
        image_models=_env_list("DEMO_IMAGE_MODELS", ("demo-image",)),
        tagline="Offline mock responses, no key needed",
        requires_key=False,
    ),
]


def _load_custom_providers() -> list[Provider]:
    raw = os.getenv("DEXBOT_PROVIDERS_JSON", "").strip()
    path = BASE_DIR / "providers.json"
    if not raw and path.exists():
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            logger.warning("Could not read %s", path)

    if not raw:
        return []

    try:
        items = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning("Invalid DEXBOT_PROVIDERS_JSON/providers.json: %s", exc)
        return []

    if isinstance(items, dict):
        items = items.get("providers", [])
    if not isinstance(items, list):
        logger.warning("Custom providers must be a JSON list")
        return []

    loaded: list[Provider] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        provider_id = str(item.get("id", "")).strip().lower()
        base_url = str(item.get("base_url", "")).strip()
        if not _ID_RE.match(provider_id) or not base_url:
            logger.warning("Skipping custom provider with invalid id/base_url")
            continue
        if any(p.id == provider_id for p in PROVIDERS) or any(
            p.id == provider_id for p in loaded
        ):
            logger.warning("Skipping duplicate custom provider id %s", provider_id)
            continue

        models = item.get("models") or []
        image_models = item.get("image_models") or []
        if not isinstance(models, list) or not isinstance(image_models, list):
            logger.warning("Skipping custom provider %s: bad models", provider_id)
            continue
        models = tuple(str(m).strip() for m in models if str(m).strip())
        image_models = tuple(str(m).strip() for m in image_models if str(m).strip())
        key_env = item.get("key_env")
        key_env = str(key_env).strip() if key_env else None
        headers = item.get("headers") or {}
        if not isinstance(headers, dict):
            headers = {}

        loaded.append(
            Provider(
                id=provider_id,
                label=str(item.get("label") or provider_id.title()),
                kind="openai",
                base_url=base_url,
                key_env=key_env,
                models=models or ("default",),
                image_models=image_models,
                docs_url=str(item.get("docs_url") or ""),
                tagline=str(item.get("tagline") or "Custom OpenAI-compatible API"),
                requires_key=bool(item.get("requires_key", bool(key_env))),
                headers=tuple((str(k), str(v)) for k, v in headers.items()),
            )
        )
    return loaded


_custom = _load_custom_providers()
if _custom:
    PROVIDERS[-1:-1] = _custom

PROVIDER_MAP: dict[str, Provider] = {p.id: p for p in PROVIDERS}

DEFAULT_PRIORITY = (
    "xai",
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "groq",
    "deepseek",
    "mistral",
    "demo",
    "ollama",
)


def default_provider() -> Provider:
    requested = os.getenv("DEXBOT_DEFAULT_PROVIDER", "").strip().lower()
    if requested in PROVIDER_MAP and PROVIDER_MAP[requested].available:
        return PROVIDER_MAP[requested]

    for provider_id in DEFAULT_PRIORITY:
        if provider_id in {"demo", "ollama"}:
            continue
        provider = PROVIDER_MAP.get(provider_id)
        if provider and provider.available:
            return provider

    for provider in PROVIDERS:
        if (
            provider.id not in DEFAULT_PRIORITY
            and provider.kind != "demo"
            and provider.available
        ):
            return provider

    if PROVIDER_MAP["ollama"].available:
        return PROVIDER_MAP["ollama"]
    return PROVIDER_MAP["demo"]


def data_dir() -> Path:
    return Path(
        os.getenv("DEXBOT_DATA_DIR", str(BASE_DIR / "data"))
    ).expanduser().resolve()


def media_dir() -> Path:
    return data_dir() / "media"


def ensure_media_dir() -> Path:
    target = media_dir()
    target.mkdir(parents=True, exist_ok=True)
    return target
