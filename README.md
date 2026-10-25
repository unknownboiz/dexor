# DexBot

A Grok-style multi-model AI chat app. One clean interface for xAI, OpenAI, Anthropic, Google, Groq, OpenRouter, DeepSeek, Mistral, Ollama, or any OpenAI-compatible API — with streaming answers, image generation, markdown/code rendering, and chat history that stays in your browser.

![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115%2B-009688)
![No build step](https://img.shields.io/badge/frontend-vanilla%20JS-f7df1e)

## Features

- **Multi-provider** — switch provider and model from the top bar, even mid-conversation.
- **Streaming chat** — token-by-token responses over SSE with a stop button.
- **Image generation** — Grok images, OpenAI images, Google Imagen, or a demo SVG generator.
- **Conversation history** — chats stored in `localStorage`, grouped by date, quick to switch, and exportable as JSON.
- **Markdown + code** — sanitized markdown, syntax highlighting, copy buttons, tables, and links.
- **Settings** — dark/light/system theme, system prompt, temperature, per-provider status.
- **Custom APIs** — add any OpenAI-compatible endpoint through `providers.json`.
- **Zero-key demo** — the app works immediately with locally generated demo responses.
- **Secure by default** — API keys stay in server-side `.env`; the browser never receives them.

## Quick start

```bash
git clone git@github.com:unknownboiz/dexor.git dexbot
cd dexbot
python -m pip install -r requirements.txt
cp .env.example .env
# optional: edit .env and add one or more API keys
python run.py
```

Open <http://localhost:8000>.

No key yet? Just start the app. The **Demo** provider is selected automatically and streams mock answers and SVG images. Add a key to `.env`, restart, and the provider appears as connected.

### Google Colab

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/unknownboiz/dexor/blob/main/DexBot_Colab.ipynb)

The notebook downloads the project, installs dependencies, starts the server, and embeds DexBot in the notebook. Because the repository is private, add a fine-grained GitHub token with **Contents: Read-only** access as a Colab secret named `GITHUB_TOKEN` — or make the repository public and skip the token.

## Providers

Add any of these to `.env`, then restart the server.

| Provider | Key | Chat | Images |
| --- | --- | --- | --- |
| xAI Grok | `XAI_API_KEY` | `grok-4`, `grok-3`, `grok-3-mini` | `grok-2-image` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4.1`, `gpt-4o`, `o3`, `o4-mini` | `gpt-image-1`, `dall-e-3` |
| Anthropic | `ANTHROPIC_API_KEY` | Claude 4.x models | — |
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.5-pro`, `gemini-2.5-flash` | Imagen models |
| Groq | `GROQ_API_KEY` | Llama / GPT-OSS / Qwen | — |
| OpenRouter | `OPENROUTER_API_KEY` | Many models, one key | — |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat`, `deepseek-reasoner` | — |
| Mistral | `MISTRAL_API_KEY` | Mistral / Codestral | — |
| Ollama | none | Any local model | — |
| Demo | none | Built-in mock | Built-in SVG |

Model lists are defaults and will age. Override them without editing code:

```bash
XAI_MODELS=grok-4,grok-3
OPENAI_MODELS=gpt-4.1,gpt-4o
GOOGLE_IMAGE_MODELS=imagen-4.0-generate-001
```

You can also type any model ID through **Custom model…** in the model picker.

### Add any OpenAI-compatible API

Create `providers.json` (next to `run.py`) or set `DEXBOT_PROVIDERS_JSON`:

```json
[
  {
    "id": "my-api",
    "label": "My API",
    "base_url": "https://example.com/v1",
    "key_env": "MY_API_KEY",
    "models": ["my-chat-model"],
    "image_models": ["my-image-model"],
    "docs_url": "https://example.com/dashboard",
    "tagline": "Private endpoint"
  }
]
```

Then put `MY_API_KEY=...` in `.env`. Any provider with `requires_key: false` works without a key (useful for local servers).

### Ollama

```bash
ollama serve            # in another terminal
ollama pull llama3.2
```

DexBot talks to `http://localhost:11434/v1` by default. Override with `OLLAMA_BASE_URL`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEXBOT_DEFAULT_PROVIDER` | first available | Provider selected on first launch |
| `DEXBOT_DATA_DIR` | `./data` | Generated images and runtime data |
| `DEXBOT_READ_TIMEOUT` | `300` | Seconds to wait for a provider |
| `DEXBOT_PROVIDERS_JSON` | — | Extra OpenAI-compatible providers |
| `DEXBOT_CHECK_OLLAMA` | `1` | Probe Ollama so offline local models are hidden |
| `ANTHROPIC_MAX_TOKENS` | `8192` | Claude response cap |
| `DEMO_DELAY` | `0.012` | Demo streaming delay (0 for tests) |

The UI stores its own settings and conversations in browser `localStorage`.

## How it works

```
app/
  config.py      provider definitions, env loading, defaults
  providers.py   streaming adapters (OpenAI, Anthropic, Google), image saving, demo
  main.py        FastAPI routes, validation, SSE stream, static files
static/
  index.html     app shell
  styles.css     Grok-style dark/light UI
  app.js         state, SSE client, markdown, history, image mode
  vendor/        marked, DOMPurify, highlight.js (vendored, no CDN needed)
tests/
  test_api.py    demo chat/image, validation, static serving
```

API surface:

- `GET /api/config` — providers, models, status (no keys)
- `POST /api/chat` — SSE events: `meta`, `delta`, `usage`, `error`, `done`
- `POST /api/images` — generate and persist an image under `/media`
- `GET /api/health`

## Tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

Tests use the demo provider only and need no network or API keys.

## Notes

- This is a single-user, local-first app. API keys are read from the server environment; there is no login or multi-tenant isolation. Bind to `127.0.0.1` if exposing it on a shared machine.
- Conversations live in the browser, not the server. Generated image files live in `data/media`; clearing the server data directory breaks image links in old chats.
- Provider error messages are shown in the chat so misconfigured keys are easy to spot.
