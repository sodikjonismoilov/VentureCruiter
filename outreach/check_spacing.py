"""Find out who drops spaces: the model, JSON mode, or the Nicrron gateway.

The model is asked to echo a fixed paragraph exactly, so any missing space is
measurable. It tries each model with and without JSON mode, 3 times each
(12 short calls, roughly 2-4 cents in total).

Run from outreach/:  .venv/bin/python check_spacing.py
"""
import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")
from openai import OpenAI  # noqa: E402

TEXT = ("I read your About page and the line about billing stuck with me. "
        "We invest at seed in software for independent clinics. "
        "Would you be open to a short call next week? I would like to hear how "
        "you think about the market. Best, Alex Rivera, Example Ventures.")
MODELS = ["anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"]
RUNS = 3

client = OpenAI(base_url=os.getenv("LLM_BASE_URL", "https://api.nicrron.ai/v1"),
                api_key=os.environ["NICRRON_API_KEY"])


def missing_spaces(out):
    """How many of TEXT's spaces are gone from the output (0 means a perfect echo)."""
    return max(0, TEXT.count(" ") - out.strip().count(" ")) if out.strip() else None


def ask(model, json_mode):
    if json_mode:
        prompt = ('Return only JSON {"text": "..."} where text is the following paragraph, '
                  "copied exactly, character for character:\n\n" + TEXT)
        kw = {"response_format": {"type": "json_object"}}
    else:
        prompt = "Repeat the following paragraph exactly, character for character, and nothing else:\n\n" + TEXT
        kw = {}
    r = client.chat.completions.create(model=model, max_tokens=300, temperature=0,
                                       messages=[{"role": "user", "content": prompt}],
                                       extra_headers={"x-nicrron-cache": "false"}, **kw)
    out = r.choices[0].message.content or ""
    if json_mode:
        try:
            out = json.loads(out[out.find("{"):out.rfind("}") + 1])["text"]
        except (ValueError, KeyError):
            return None, out
    return missing_spaces(out), out


for model in MODELS:
    for json_mode in (True, False):
        results = []
        for _ in range(RUNS):
            try:
                results.append(ask(model, json_mode))
            except Exception as e:  # show the error and keep testing the rest
                results.append((None, f"ERROR {e}"))
        counts = [n for n, _ in results]
        print(f"{model:32} json={'on ' if json_mode else 'off'}  missing spaces per run: {counts}")
        for n, out in results:
            if n:
                print(f"    sample: {out[:160]!r}")
                break

print("\nAll zeros: the dropped spaces came from the draft prompt, and _tidy() handles the visible cases.")
print("Non-zero for every model: Nicrron is mangling text. Try another gateway via LLM_BASE_URL.")
print("Non-zero for one model only: switch OUTREACH_MODEL in .env to the clean one.")
print("Non-zero only with json=on: tell me, and we'll drop JSON mode for the drafts.")
