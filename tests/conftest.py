from __future__ import annotations

import os
import shutil
import tempfile

_TEST_DATA_DIR = tempfile.mkdtemp(prefix="dexbot-test-")
os.environ["DEXBOT_DATA_DIR"] = _TEST_DATA_DIR
os.environ["DEMO_DELAY"] = "0"
os.environ["DEMO_IMAGE_DELAY"] = "0"

for _key in (
    "XAI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
):
    os.environ[_key] = ""


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    shutil.rmtree(_TEST_DATA_DIR, ignore_errors=True)
