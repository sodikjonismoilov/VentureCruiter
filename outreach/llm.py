"""Nicrron (OpenAI-compatible) client for the outreach API.

Set MOCK_LLM=1 to get canned answers with no network and no cost,
so the frontend can be built and tested without spending credits.
"""
import json
import os
import time

import httpx
from openai import APIStatusError, AuthenticationError, OpenAI

BASE_URL = os.getenv("LLM_BASE_URL", "https://api.nicrron.ai/v1")
MODEL = os.getenv("OUTREACH_MODEL", "anthropic/claude-sonnet-5-5")


class OutOfCredits(Exception):
    """Nicrron answered 402: the balance can't cover this request."""


class LLMError(Exception):
    """The model or gateway failed in a way the caller should see as a 502."""


def mock_enabled():
    return os.getenv("MOCK_LLM", "").strip().lower() in ("1", "true", "yes")


_client = None


def _api_key():
    key = os.getenv("NICRRON_API_KEY", "").strip()
    if not key:
        raise LLMError("NICRRON_API_KEY is not set. Put it in outreach/.env, or set MOCK_LLM=1.")
    return key


def client():
    global _client
    if _client is None:
        _client = OpenAI(base_url=BASE_URL, api_key=_api_key(), max_retries=2, timeout=120)
    return _client


def _parse_json(text):
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise LLMError(f"Model did not return JSON: {text[:200]!r}")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise LLMError(f"Model returned invalid JSON: {e}") from e


def ask_json(system, user, mock_answer, max_tokens=2500):
    """Ask for a JSON object. Returns (data, generation_id).

    mock_answer is what MOCK_LLM mode returns instead of calling the model.
    """
    if mock_enabled():
        return mock_answer, None
    try:
        r = client().chat.completions.create(
            model=MODEL,
            max_tokens=max_tokens,
            temperature=0.7,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user}],
            response_format={"type": "json_object"},
            extra_headers={"x-nicrron-cache": "false"},
        )
    except AuthenticationError as e:
        raise LLMError("Nicrron rejected the API key. Check NICRRON_API_KEY in outreach/.env.") from e
    except APIStatusError as e:
        if e.status_code == 402:
            raise OutOfCredits("Nicrron balance is too low for this request. Add credits.") from e
        raise LLMError(f"Nicrron error {e.status_code}: {str(e)[:200]}") from e
    if not r.choices:
        raise LLMError("Nicrron returned no choices.")
    choice = r.choices[0]
    if choice.finish_reason == "length":
        u = r.usage
        details = getattr(u, "completion_tokens_details", None) if u else None
        reasoning = getattr(details, "reasoning_tokens", None) if details else None
        raise LLMError(
            f"Model hit max_tokens={max_tokens} before finishing the JSON "
            f"(completion_tokens={getattr(u, 'completion_tokens', '?')}, reasoning_tokens={reasoning}, "
            f"visible chars={len(choice.message.content or '')}, request id={r.id}).")
    return _parse_json(choice.message.content or ""), r.id


def cost_of(generation_id, tries=4, wait=0.5):
    """Exact cost in USD (fee included) from GET /v1/generation, or None.

    Billing settles a moment after the request, so a 404 right away is normal; retry briefly.
    """
    if not generation_id or mock_enabled():
        return 0.0 if mock_enabled() else None
    headers = {"Authorization": f"Bearer {_api_key()}"}
    for _ in range(tries):
        try:
            r = httpx.get(f"{BASE_URL}/generation", params={"id": generation_id},
                          headers=headers, timeout=10)
        except httpx.HTTPError:
            return None
        if r.status_code == 200:
            return float(r.json()["data"]["total_cost"])
        if r.status_code != 404:
            return None
        time.sleep(wait)
    return None
