"""Cypher outreach API: draft personal emails for shortlisted founders,
approve or skip them, and draft answers to founder replies.

Run:  python app.py        (http://localhost:5001, MOCK_LLM=1 for no-cost testing)
Nothing here sends email. "Approved" only marks a draft.
"""
import json
import os
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

from flask import Flask, jsonify, request  # noqa: E402
from flask_cors import CORS  # noqa: E402
from werkzeug.exceptions import HTTPException  # noqa: E402

import from_funnel  # noqa: E402
import llm  # noqa: E402
import prompts  # noqa: E402

MAX_RECORDS = 25  # caps the cost of one /drafts call
# The lead funnel's founder results, one folder per fund. Relative paths are relative to outreach/.
# Deployed alone (e.g. on Render) this folder may not exist; the /funds routes then answer 404.
FUNNEL_OUT_DIR = (HERE / os.getenv("FUNNEL_OUT_DIR", "../lead-funnel/out/founders")).resolve()
DEFAULT_SLOTS = [s.strip() for s in os.getenv(
    "AVAILABILITY",
    "Tue Oct 27, 2:00 PM ET; Wed Oct 28, 11:00 AM ET; Thu Oct 29, 4:00 PM ET",
).split(";") if s.strip()]

app = Flask(__name__)
# Werkzeug would 308-redirect /funds/..%2F/x (decoded: /funds/..//x) to a merged path; answer 404 instead.
app.url_map.merge_slashes = False
CORS(app, origins=os.getenv("FRONTEND_ORIGIN", "*"))

_lock = threading.Lock()
DRAFTS = {}                                  # id -> draft (in memory: resets on restart)
COST = {"total_usd": 0.0, "requests": 0, "unpriced": 0}


def _investor(body):
    inv = (body or {}).get("investor") or {}
    return {"name": inv.get("name") or os.getenv("INVESTOR_NAME", "Alex Rivera"),
            "firm": inv.get("firm") or os.getenv("INVESTOR_FIRM", "Example Ventures")}


def _track(gen_id):
    cost = llm.cost_of(gen_id)
    with _lock:
        COST["requests"] += 1
        if cost is None:
            COST["unpriced"] += 1
        else:
            COST["total_usd"] += cost
    return cost


def _tidy(text, investor):
    """Repair spacing the model or gateway sometimes drops.

    Fixes what can be detected safely: a missing space after a sentence end
    ("clinics.Ledgerline") and the investor's name or firm glued together
    ("AlexRivera"). A glued pair of ordinary words ("hearhow") can't be
    detected without a dictionary, which is what check_spacing.py is for.
    """
    text = re.sub(r"(?<=[a-z0-9)])([.!?])(?=[A-Z])", r"\1 ", text)
    for full in (investor["name"], investor["firm"]):
        if " " in full:
            text = text.replace(full.replace(" ", ""), full)
    return text


def _public(d):
    return {k: d[k] for k in ("id", "lead_id", "fund", "founder_name", "company", "subject", "body",
                              "status", "cost_usd", "thread")}


def _bad(msg, code=400):
    return jsonify({"error": msg}), code


@app.errorhandler(HTTPException)
def _http_error(e):
    # Unknown paths (e.g. /funds/..%2F/shortlist) get JSON too, never Flask's HTML page.
    return _bad(e.description, e.code)


@app.errorhandler(llm.OutOfCredits)
def _out_of_credits(e):
    return _bad(str(e), 402)


@app.errorhandler(llm.LLMError)
def _llm_error(e):
    return _bad(str(e), 502)


@app.get("/health")
def health():
    return jsonify({"ok": True, "mock": llm.mock_enabled(), "model": llm.MODEL})


@app.post("/drafts")
def create_drafts():
    body = request.get_json(silent=True) or {}
    return _draft(body.get("records"), _investor(body))


def _draft(records, investor, fund=None):
    """Validate shortlist records and draft one email each. Used by /drafts and /funds/<fund>/drafts."""
    if not isinstance(records, list) or not records:
        return _bad("Send {\"records\": [...]} with at least one shortlist record.")
    if len(records) > MAX_RECORDS:
        return _bad(f"At most {MAX_RECORDS} records per call.")
    for i, r in enumerate(records):
        if not isinstance(r, dict) or not r.get("company") or not r.get("why"):
            return _bad(f"records[{i}] needs at least 'company' and 'why'.")

    def one(r):
        name = r.get("founder_name") or ""
        mock = {"subject": f"{r['company']} and {investor['firm']}",
                "body": f"Hi {name or r['company'] + ' team'},\n\n[MOCK DRAFT] {r['why']}\n\n"
                        f"Open to a 20-minute call?\n\n{investor['name']}, {investor['firm']}"}
        data, gen_id = llm.ask_json(prompts.DRAFT_SYSTEM, prompts.draft_user(r, investor), mock)
        if not data.get("subject") or not data.get("body"):
            raise llm.LLMError("Draft is missing subject or body.")
        return {"id": uuid.uuid4().hex[:12], "record": r, "investor": investor,
                "lead_id": r.get("lead_id"), "fund": fund,
                "founder_name": name, "company": r["company"],
                "subject": _tidy(data["subject"], investor), "body": _tidy(data["body"], investor),
                "status": "pending", "cost_usd": _track(gen_id), "thread": []}

    with ThreadPoolExecutor(max_workers=4) as pool:
        drafts = list(pool.map(one, records))
    with _lock:
        for d in drafts:
            DRAFTS[d["id"]] = d
    return jsonify({"drafts": [_public(d) for d in drafts]})


@app.get("/drafts")
def list_drafts():
    with _lock:
        return jsonify({"drafts": [_public(d) for d in DRAFTS.values()]})


def _get(draft_id):
    with _lock:
        return DRAFTS.get(draft_id)


@app.post("/drafts/<draft_id>/approve")
def approve(draft_id):
    d = _get(draft_id)
    if not d:
        return _bad("No such draft.", 404)
    edited = (request.get_json(silent=True) or {}).get("body")
    with _lock:
        if isinstance(edited, str) and edited.strip():
            d["body"] = edited.strip()
            d["edited"] = True
        d["status"] = "approved"
    return jsonify({"id": d["id"], "status": d["status"]})


@app.post("/drafts/<draft_id>/skip")
def skip(draft_id):
    d = _get(draft_id)
    if not d:
        return _bad("No such draft.", 404)
    with _lock:
        d["status"] = "skipped"
    return jsonify({"id": d["id"], "status": d["status"]})


@app.post("/drafts/<draft_id>/reply")
def reply(draft_id):
    d = _get(draft_id)
    if not d:
        return _bad("No such draft.", 404)
    if d["status"] != "approved":
        return _bad("Approve the draft before handling a reply.", 409)
    body = request.get_json(silent=True) or {}
    reply_text = (body.get("reply_text") or "").strip()
    if not reply_text:
        return _bad("Send {\"reply_text\": \"...\"}.")
    slots = body.get("availability") or DEFAULT_SLOTS

    mock = {"intent": "interested", "proposed_times": slots[:2],
            "response_body": f"[MOCK REPLY] Great to hear. Would {slots[0]} work?\n\n{d['investor']['name']}"}
    data, gen_id = llm.ask_json(prompts.REPLY_SYSTEM,
                                prompts.reply_user(d, reply_text, slots, d["investor"]), mock)

    # Only keep times we actually offered: the model must not invent a slot.
    proposed = [t for t in data.get("proposed_times") or [] if t in slots]
    intent = data.get("intent") if data.get("intent") in ("interested", "declined", "unclear") else "unclear"
    turn = {"founder": reply_text, "response_body": _tidy(data.get("response_body", ""), d["investor"]),
            "intent": intent, "proposed_times": proposed, "cost_usd": _track(gen_id)}
    with _lock:
        d["thread"].append(turn)
    return jsonify(turn)


@app.get("/cost")
def cost():
    with _lock:
        return jsonify({**COST, "total_usd": round(COST["total_usd"], 6)})


# ---------- lead funnel results (read only) ----------

class FunnelMissing(Exception):
    """A fund, its files or a dossier isn't in FUNNEL_OUT_DIR: answered as a 404."""


@app.errorhandler(FunnelMissing)
def _funnel_missing(e):
    return _bad(str(e), 404)


def _fund_names():
    if not FUNNEL_OUT_DIR.is_dir():
        raise FunnelMissing(f"No lead-funnel results folder at {FUNNEL_OUT_DIR}. Set FUNNEL_OUT_DIR.")
    return sorted(p.name for p in FUNNEL_OUT_DIR.iterdir() if p.is_dir() and not p.name.startswith("."))


def _fund_dir(fund):
    """The fund's run folder. Only names from the folder listing are accepted, so no path traversal."""
    if "/" in fund or "\\" in fund or ".." in fund or fund not in _fund_names():
        raise FunnelMissing(f"Unknown fund {fund!r}. GET /funds lists the funds.")
    return FUNNEL_OUT_DIR / fund


def _read_json(path, what):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise FunnelMissing(f"{what} not found: run the lead funnel for this fund first.") from None
    except (OSError, ValueError) as e:
        raise FunnelMissing(f"{what} could not be read: {e}") from None


def _records(fund, min_fit, skip=()):
    """from_funnel records for a fund and the details behind them (leads, shortlist order, drops)."""
    run_dir = _fund_dir(fund)
    for name in ("leads.json", "last_rank.json"):
        if not (run_dir / name).exists():
            raise FunnelMissing(f"{fund}/{name} not found: run `run.py rank` for this fund first.")
    try:
        records, info = from_funnel.build_with_details(run_dir, min_fit, skip)
    except (OSError, ValueError, KeyError) as e:
        raise FunnelMissing(f"Results for {fund!r} could not be read: {e}") from None
    return records, info


def _min_fit(value):
    """min_fit from a query string or JSON body: an integer, default 3."""
    if value is None or value == "":
        return 3
    if isinstance(value, bool) or not str(value).strip().lstrip("-").isdigit():
        raise ValueError
    return int(value)


@app.get("/funds")
def funds():
    return jsonify({"funds": [{"name": f,
                               "has_leads": (FUNNEL_OUT_DIR / f / "leads.json").exists(),
                               "has_dossiers": (FUNNEL_OUT_DIR / f / "dossiers.json").exists()}
                              for f in _fund_names()]})


@app.get("/funds/<fund>/shortlist")
def fund_shortlist(fund):
    try:
        min_fit = _min_fit(request.args.get("min_fit"))
    except ValueError:
        return _bad("min_fit must be a whole number (1-5).")
    # ?skip=co:1,co:2 or ?skip=co:1&skip=co:2
    skip = {s.strip() for v in request.args.getlist("skip") for s in v.split(",") if s.strip()}
    records, info = _records(fund, min_fit, skip)
    rank = {lead_id: i for i, lead_id in enumerate(info["shortlist"], 1)}
    for r in records:
        r["rank"] = rank.get(r["lead_id"])
        r["score"] = info["leads"][r["lead_id"]].get("score")
    return jsonify({"fund": fund, "min_fit": min_fit, "records": records,
                    "dropped": {k: info[k] for k in ("low_fit", "skipped", "unusable")}})


@app.get("/funds/<fund>/dossiers/<lead_id>")
def fund_dossier(fund, lead_id):
    bundle = _read_json(_fund_dir(fund) / "dossiers.json", f"{fund}/dossiers.json")
    for d in bundle.get("founders") or []:
        if d.get("lead_id") == lead_id:
            return jsonify(d)
    raise FunnelMissing(f"No dossier for {lead_id!r} in {fund}.")


@app.post("/funds/<fund>/drafts")
def fund_drafts(fund):
    body = request.get_json(silent=True) or {}
    try:
        min_fit = _min_fit(body.get("min_fit"))
    except ValueError:
        return _bad("min_fit must be a whole number (1-5).")
    lead_ids = body.get("lead_ids")
    if lead_ids is not None and (not isinstance(lead_ids, list) or not all(isinstance(i, str) for i in lead_ids)):
        return _bad("lead_ids must be a list of lead id strings.")
    records, _ = _records(fund, min_fit)
    if lead_ids:
        by_id = {r["lead_id"]: r for r in records}
        missing = [i for i in lead_ids if i not in by_id]
        if missing:
            return _bad(f"Not on the {fund} shortlist at min_fit {min_fit}: {', '.join(missing)}. "
                        f"GET /funds/{fund}/shortlist lists them.")
        records = [by_id[i] for i in dict.fromkeys(lead_ids)]
    if not records:
        return _bad(f"No {fund} shortlist records at min_fit {min_fit}.")
    return _draft(records, _investor(body), fund=fund)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", "5001")), debug=True, threaded=True)
