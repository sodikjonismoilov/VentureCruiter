"""Runs founder sourcing for one fund thesis and writes the report. Called by `run.py rank`."""
import csv
import json
import os
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

from . import builders, founders as F
from .score import best_passages, learned_weights, load_connections, load_labels, text_similarity

CONTEXT = "report_context.json"  # funnel counts, notes, weights and fallback quotes: report.md inputs not in leads.json


def _readme(l, cache: Path):
    """GitHub README text for a builder's repo (raw.githubusercontent.com, free, cached)."""
    repo = l["url"].removeprefix("https://github.com/")
    path = cache / ("readme-" + repo.replace("/", "__") + ".txt")
    if path.exists():
        return path.read_text()
    try:
        req = urllib.request.Request(f"https://raw.githubusercontent.com/{repo}/HEAD/README.md", headers={"User-Agent": "lead-funnel/0.1"})
        with urllib.request.urlopen(req, timeout=15) as r:
            text = r.read(60000).decode("utf-8", "replace")
    except Exception:
        text = ""
    cache.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return text


def _take(items, n, share, min_fit=None):
    """Top n by score, with up to `share` of the places kept for pre-round builders (if there are enough of them).
    With min_fit, only builders Claude rated at least that fit can use the kept places; others compete on score."""
    ranked = sorted(items, key=lambda l: -l["score"])
    eligible = lambda l: l["kind"] == "builder" and (min_fit is None or (l.get("judgment") or {}).get("fit", 0) >= min_fit)
    builders = [l for l in ranked if eligible(l)][: int(round(n * share))]
    keep = {l["id"] for l in builders}
    rest = [l for l in ranked if l["id"] not in keep][: n - len(builders)]
    return sorted(builders + rest, key=lambda l: -l["score"])


def run(th, t, args, data: Path, here: Path):
    from .web import enrich as web_enrich
    today = date.today()
    run_cfg = {"sourced": 1000, "screen": 200, "deep": 50, "shortlist": 15, "judge_effort": "high", "pre_round_share": 1 / 3,
               "min_builder_fit": 3, **t.get("run", {})}
    share = run_cfg["pre_round_share"]
    notes, counts = [], []

    # Stage 0 · every lead: startups raising now, builders before the round, optional akta.pro list
    if not (data / "startups.json").exists():
        from .startups import build_startups
        build_startups(data, json.loads((data / "universe.json").read_text()))
    leads = F.startup_leads(data)
    counts.append(("Startups raising now (Form D, last 2 years, named officers)", len(leads)))
    cache = data / "signals"
    for name, fn in (("GitHub", builders.github), ("Show HN", builders.show_hn), ("arXiv", builders.arxiv)):
        try:
            found, n = fn(t, cache)
        except Exception as e:
            found, n = [], [f"{name}: {str(e)[:120]}"]
        notes += n
        leads += found
        counts.append((f"Builders from {name} (thesis keywords, recent)", len(found)))
    key = os.environ.get("AKTA_API_KEY")
    if args.akta_list and key and not args.no_akta:
        from .akta import Akta, AktaError, BudgetStop
        client = Akta(key, data / "akta", allow_paid=True)
        worst = 1.5 + (0 if t.get("akta_filters") else 2.5) + 0.2 * args.akta_list
        print(f"akta.pro list generation: up to {args.akta_list} companies, at most {worst:g} credits. "
              f"This month: {client.ledger.used():g} used, {client.ledger.left():g} usable left.")
        try:
            res = client.list_companies(query=t.get("akta_query") or t["one_liner"], filters=t.get("akta_filters"), limit=args.akta_list)
            rows = res.get("data", [])
            leads += F.akta_leads(rows)
            notes.append(f"akta.pro list: {len(rows)} companies, {client.credits:g} credits this run; {client.ledger.left():g} usable left this month.")
        except (BudgetStop, AktaError) as e:
            notes.append(f"akta.pro list: not run ({e}).")
        counts.append(("Companies from akta.pro List Generation", sum(1 for l in leads if l["kind"] == "company")))
    elif args.akta_list and not key:
        notes.append("akta.pro list: skipped, no AKTA_API_KEY.")
    for l in leads:  # one shape for every source
        for k, v in {"stage": "pre-round" if l["kind"] == "builder" else "unknown", "state": "", "industry": "", "location": "",
                     "people": [l["person"]] if l.get("person") else [], "person_title": "", "website": "", "contact": "", "url": ""}.items():
            l.setdefault(k, v)
    F.link_people(leads)
    by_id = {l["id"]: l for l in leads}
    counts.insert(0, ("All leads", len(leads)))

    labels = load_labels(th.labels)
    connections = load_connections(here / "connections.csv")
    saved = json.loads(th.features.read_text()) if th.features.exists() else {}
    weights, wnote = learned_weights({i: {"features": v} for i, v in saved.items()}, labels, F.FEATURES, F.DEFAULT_WEIGHTS)

    # Stage 1 · sourcing: hard rules and structured signals only
    pool = [l for l in leads if F.hard_filter(l, t, today)]
    counts.append(("Pass hard filters (recent, stage, founded, on-thesis keywords)", len(pool)))
    for l in pool:
        F.features(l, t, today, connections)
        l["score"] = F.stage_score(l, "source", weights)
    sourced = _take(pool, run_cfg["sourced"], share)
    counts.append(("Sourced: stage, recency, relevance, traction, founder signals", len(sourced)))

    # Stage 2 · screen: language similarity to the thesis on what we already know
    text_similarity(sourced, t, labels, doc_fn=F.doc, query_text=F.thesis_text(t))
    for l in sourced:
        l["excluded_by"], l["conflicts"] = F.penalty(l, t)
        l["score"] = F.stage_score(l, "screen", weights)
    screened = _take(sourced, run_cfg["screen"], share)
    counts.append(("Screened: language match to the thesis", len(screened)))

    # Stage 3 · deep: find startup websites (free), read sites and READMEs, recompute
    print(f"Stage 3: finding websites and reading pages for {len(screened)} leads…")
    F.guess_sites(screened, data / "sites.json")
    if key and not args.no_akta:
        from .akta import Akta
        n = F.akta_sites(sorted(screened, key=lambda l: -l["score"]), Akta(key, data / "akta", allow_paid=False), limit=100)
        notes.append(f"akta.pro company search (free): {n} lookups for startup websites.")
    web_enrich(screened, data / "web", deep=True)
    for l in screened:
        if l["source"] == "GitHub":
            rd = _readme(l, cache)
            if rd:
                l["pages"].append({"url": l["url"], "text": rd[:15000]})
    found_sites = sum(1 for l in screened if l["kind"] == "startup" and l["website"])
    notes.append(f"Websites found for {found_sites} of {sum(1 for l in screened if l['kind'] == 'startup')} screened Form D startups.")
    vec, profile = text_similarity(screened, t, labels, doc_fn=F.doc, query_text=F.thesis_text(t))
    for l in screened:
        l["excluded_by"], l["conflicts"] = F.penalty(l, t)
        l["score"] = F.stage_score(l, "deep", weights)
    deep = _take(screened, run_cfg["deep"], share)
    counts.append(("Deep: websites, READMEs, warm paths", len(deep)))

    # Stage 4 · judge
    from .judge import judge_founders, provider
    which = None if args.no_claude else provider()
    fund_text = f"Fund: {t.get('fund_name', '')}\n" + F.thesis_text(t) + (f"\nPortfolio (conflicts): {', '.join(t.get('portfolio', []))}" if t.get("portfolio") else "")
    if which:
        print(f"Stage 4: Claude judging {len(deep)} founders via {'Anthropic API' if which == 'anthropic' else 'Nicrron gateway'}…")
        judge_founders(deep, fund_text, labels, by_id, data / "judge", effort=run_cfg["judge_effort"])
        for l in deep:
            j = l.get("judgment") or {}
            if "fit" in j:
                l["features"]["claude"] = round(0.7 * (j["fit"] - 1) / 4 + 0.3 * (j["founder_quality"] - 1) / 4, 3)
                if j.get("conflict"):
                    l["conflicts"] = l["conflicts"] or ["Claude flagged overlap with the portfolio"]
        errs = [l["judgment"]["error"] for l in deep if "error" in (l.get("judgment") or {})]
        notes.append(f"Claude Opus 5.5 via {'Anthropic' if which == 'anthropic' else 'Nicrron'}: judged {len(deep) - len(errs)} of {len(deep)}." + (f" Errors: {errs[0]}" if errs else ""))
    else:
        notes.append("Claude: off. Final ranking uses scores only; quotes are the closest sentences in the evidence.")
    for l in deep:
        l["score"] = F.stage_score(l, "final", weights)
        l["passages"] = best_passages(l, vec, profile)
    ranked = sorted(deep, key=lambda l: -l["score"])
    judged = any("fit" in (l.get("judgment") or {}) for l in ranked)
    unjudged = [l for l in ranked if judged and "fit" not in (l.get("judgment") or {})]
    if unjudged:  # scored without Claude they would outrank judged leads, so they wait for the next judged run
        notes.append(f"Not yet judged, kept off the shortlist: {', '.join((l['person'] + ' · ' + l['company']).strip(' ·') for l in unjudged[:8])}"
                     + (f" ({(unjudged[0].get('judgment') or {}).get('error', '')})" if (unjudged[0].get("judgment") or {}).get("error") else "") + ".")
    shortlist = _take([l for l in ranked if not l["conflicts"] and l not in unjudged], run_cfg["shortlist"], share,
                      min_fit=run_cfg["min_builder_fit"] if judged else None)  # without Claude there is no fit to check
    if judged:
        kept = sum(1 for l in shortlist if l["kind"] == "builder")
        notes.append(f"Pre-round builders on the shortlist: {kept} (places are kept only for builders Claude rates fit "
                     f"{run_cfg['min_builder_fit']}/5 or better; best builder fit this run: "
                     f"{max([(l.get('judgment') or {}).get('fit', 0) for l in ranked if l['kind'] == 'builder'] or [0])}/5).")
    overlaps = [l for l in ranked if l["conflicts"]]
    counts.append(("Shortlist", len(shortlist)))

    for l in sourced:
        saved[l["id"]] = l["features"]
    th.features.parent.mkdir(parents=True, exist_ok=True)
    th.features.write_text(json.dumps(saved))
    th.out.mkdir(parents=True, exist_ok=True)
    th.ranks.write_text(json.dumps([l["id"] for l in shortlist]))
    keep = ("id", "kind", "source", "stage", "person", "people", "company", "location", "website", "website_note", "date", "industry",
            "headline", "url", "contact", "handle", "officer_keys", "text", "signals", "also", "features", "score", "judgment", "conflicts", "excluded_by", "warm_why")
    (th.out / "leads.json").write_text(json.dumps([{k: l.get(k) for k in keep} for l in ranked], indent=1))
    _csv(th.out / "shortlist.csv", shortlist)
    _csv(th.out / "sourced.csv", sourced)
    # What the report needs beyond leads.json, so `run.py report` can re-render it without a funnel run.
    # Optional: a failure here must never cost a finished rank run.
    try:
        (th.out / CONTEXT).write_text(json.dumps({
            "generated": date.today().isoformat(), "counts": counts, "notes": notes, "wnote": wnote, "weights": weights,
            "passages": {l["id"]: l["passages"][:1] for l in shortlist if l.get("passages")}}, indent=1))
    except Exception as e:
        print(f"Warning: could not write {CONTEXT} ({e}); report.md is still written, but `run.py report` will need a new rank run.")
    _report(th.out / "report.md", t, counts, notes, wnote, weights, shortlist, overlaps, labels)
    print("\n".join(f"  {n:>7,}  {label}" for label, n in counts))
    print(f"\nWrote {th.out / 'report.md'}")


def _csv(path, rows):
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["rank", "lead_id", "person", "company", "kind", "source", "stage", "location", "website", "contact", "score", *F.FEATURES])
        for i, l in enumerate(rows, 1):
            w.writerow([i, l["id"], l["person"], l["company"], l["kind"], l["source"], l["stage"], l.get("location", ""), l.get("website", ""),
                        l.get("contact", ""), l["score"], *[l["features"].get(k, "") for k in F.FEATURES]])


def _held_back(shortlist, t):
    """Display only: shortlisted leads the report lists under "Also considered" instead of the main list,
    with the reasons. Off unless the thesis sets [run] min_shortlist_fit; never changes scores or leads.json."""
    min_fit = (t.get("run") or {}).get("min_shortlist_fit") or 0
    if not min_fit:
        return {}
    # report_exclusions: extra words for this check only; `exclusions` also feeds the funnel's scoring, these don't
    words = list(dict.fromkeys(t.get("exclusions", []) + (t.get("run") or {}).get("report_exclusions", [])))
    held = {}
    for l in shortlist:
        j = l.get("judgment") or {}
        why = [f"Claude fit {j['fit']}/5, below {min_fit}"] if "fit" in j and j["fit"] < min_fit else []
        # The funnel's exclusion check reads site language; this one reads Claude's own summary of the company
        said = f"{j.get('what_they_build') or ''} {j.get('why') or ''}".lower()
        why += [f"matches exclusion: {e}" for e in words if re.search(r"\b" + re.escape(e.lower()) + r"\b", said)]
        if why:
            held[l["id"]] = why
    return held


def _who(l):
    return l["person"] or (l.get("judgment") or {}).get("contact") or "founder unknown"


def _report(path, t, counts, notes, wnote, weights, shortlist, overlaps, labels, generated=None):
    held = _held_back(shortlist, t)
    filtered = bool((t.get("run") or {}).get("min_shortlist_fit"))
    shown = [l for l in shortlist if l["id"] not in held]
    if filtered:
        notes = notes + [f"Shown: {len(shown)} of {len(shortlist)} shortlisted founders. {len(held)} with Claude fit under "
                         f"{t['run']['min_shortlist_fit']}/5 or a thesis exclusion in Claude's summary are under Also considered."]
    L = [f"# Founder shortlist: {t.get('fund_name', 'Fund')}", "", f"**Thesis:** {t['one_liner']}", "",
         f"Generated {generated or date.today().isoformat()}. Sources: SEC Form D, GitHub, Show HN, arXiv, startup websites"
         + (", akta.pro" if any(l["source"] == "akta.pro" for l in shortlist) else "")
         + (", Claude" if any("fit" in (l.get("judgment") or {}) for l in shortlist) else "") + ".", "",
         "## Funnel", "", "| Stage | Leads |", "|---|---:|"] + [f"| {label} | {n:,} |" for label, n in counts]
    L += ["", *[f"- {n}" for n in notes], f"- Weights: {wnote}.", "", "| Feature | Weight |", "|---|---:|"]
    L += [f"| {k} | {weights[k]:.2f} |" for k in F.FEATURES] + ["", "## Founders", ""]
    for i, l in enumerate(shown, 1):
        j = l.get("judgment") or {}
        who = _who(l)
        # With the filter on, list numbers no longer match last_rank.json, so the label command names the lead id
        ref = l["id"] if filtered else i
        L.append(f"### {i}. {who}" + (f" · {l['company']}" if l["company"] else "") + f" · score {l['score']:.2f}"
                 + (" · ✓ liked" if labels.get(l["id"], (0,))[0] > 0 else ""))
        stage = {"raising": "Raising now", "pre-round": "Before the round", "unknown": "Stage unknown"}[l["stage"]]
        L.append(f"\n**{stage}** ({l['source']}): {l['headline']}")
        if j.get("what_they_build"):
            L.append(f"\n**What they build:** {j['what_they_build']}")
        if j.get("why"):
            L.append(f"\n**Why meet (Claude: fit {j['fit']}/5, founder {j['founder_quality']}/5, stage {j.get('stage_read', '?')}):** {j['why']}")
        if j.get("quote"):
            L.append(f"\n> {j['quote']}\n> — {j.get('quote_url') or 'their evidence'} (verified)")
        elif l.get("passages"):
            p = l["passages"][0]
            L.append(f"\n> {p['text']}\n> — {p['url']} (closest sentence to the thesis)")
        if j.get("shared_beliefs"):
            L.append("\n**Shared beliefs:** " + "; ".join(j["shared_beliefs"]))
        s, ev = l.get("signals", {}), []
        if l.get("people") and len(l["people"]) > 1:
            ev.append("team on filings: " + ", ".join(l["people"][:4]))
        if s.get("repeat_founders"):
            ev.append("repeat founder: " + ", ".join(s["repeat_founders"]))
        if s.get("backed_by"):
            ev.append("directors from " + ", ".join(s["backed_by"][:3]))
        if l.get("also"):
            ev.append(l["also"])
        if l.get("website"):
            ev.append(f"site {l['website']}" + (f" ({l['website_note']})" if l.get("website_note") else ""))
        ev.append(f"source {l['url']}" if l.get("url") else "")
        L.append("\n**Evidence:** " + "; ".join(e for e in ev if e) + ".")
        contact = [x for x in (j.get("contact") if j.get("contact") and j.get("contact") != l["person"] else "", l.get("contact")) if x]
        if contact or l.get("warm_why"):
            L.append("\n**Reach:** " + "; ".join(contact + ([l["warm_why"]] if l.get("warm_why") else [])))
        risks = (j.get("concerns") or []) + ([l["excluded_by"]] if l.get("excluded_by") else [])
        if risks:
            L.append("\n**Watch out:** " + "; ".join(risks))
        L.append("\n**Score:** " + " · ".join(f"{k} {l['features'][k]:.2f}" for k in F.FEATURES if k in l["features"]))
        L.append(f"\n`python run.py label {ref} yes \"why\"` or `python run.py label {ref} no \"why\"`\n")
    if overlaps:
        L += ["## Possible portfolio overlap (review)", ""] + [f"- **{l['person']} · {l['company']}**: {'; '.join(l['conflicts'])}" for l in overlaps[:15]]
    if held:
        L += ([""] if overlaps else []) + ["## Also considered", "",
              "Shortlisted on score, but Claude rated the fit low or its summary names a thesis exclusion. "
              "`python run.py show <lead id>` has the full brief.", ""]
        for l in shortlist:
            if l["id"] in held:
                j = l.get("judgment") or {}
                L.append(f"- **{_who(l)}" + (f" · {l['company']}" if l["company"] else "") + f"** (`{l['id']}`, score {l['score']:.2f}): "
                         + "; ".join(held[l["id"]]) + (f". {j['what_they_build']}" if j.get("what_they_build") else ""))
    path.write_text("\n".join(L) + "\n")


def write_report(th, t):
    """Re-render report.md from the saved leads.json and last_rank.json: no funnel run, no API calls."""
    for p in (th.out / "leads.json", th.ranks):
        if not p.exists():
            sys.exit(f"No {p.name} in {th.out}. Run: python run.py rank --thesis {th.path.name}")
    leads = json.loads((th.out / "leads.json").read_text())  # all finalists, best score first
    by_id = {l["id"]: l for l in leads}
    shortlist = [by_id[i] for i in json.loads(th.ranks.read_text()) if i in by_id]
    ctx_path = th.out / CONTEXT
    if ctx_path.exists():
        ctx = json.loads(ctx_path.read_text())
    else:  # a run from before report_context.json existed: read those inputs back from its report.md, once
        ctx = _context_from_report(th.out / "report.md", shortlist, th)
        ctx_path.write_text(json.dumps(ctx, indent=1))
        print(f"Saved {ctx_path.name} from the current report.md (funnel counts, notes, weights, fallback quotes).")
    for l in shortlist:
        l["passages"] = ctx["passages"].get(l["id"], [])
    _report(th.out / "report.md", t, [tuple(c) for c in ctx["counts"]], ctx["notes"], ctx["wnote"], ctx["weights"],
            shortlist, [l for l in leads if l.get("conflicts")], load_labels(th.labels), generated=ctx["generated"])
    held = _held_back(shortlist, t)
    print(f"Wrote {th.out / 'report.md'}: {len(shortlist) - len(held)} shown, {len(held)} under Also considered.")


def _context_from_report(path, shortlist, th):
    """The report inputs leads.json doesn't keep, parsed from a report.md that _report wrote."""
    if not path.exists():
        sys.exit(f"No {CONTEXT} or report.md in {th.out}. Run: python run.py rank --thesis {th.path.name}")
    text = path.read_text()
    funnel = text.split("\n## Funnel\n", 1)[-1].split("\n## Founders\n", 1)[0]
    stages, _, rest = funnel.partition("\n\n- ")
    counts = [[m[1], int(m[2].replace(",", ""))] for m in re.finditer(r"^\| (.+) \| ([\d,]+) \|$", stages, re.M)]
    bullets = [b[2:] for b in ("- " + rest).split("\n\n", 1)[0].splitlines() if b.startswith("- ")]
    notes = [b for b in bullets if not b.startswith(("Weights: ", "Shown: "))]  # "Shown:" is added by _report itself
    wnote = next((b.removeprefix("Weights: ").removesuffix(".") for b in bullets if b.startswith("Weights: ")), "")
    weights = {m[1]: float(m[2]) for m in re.finditer(r"^\| (\w+) \| (-?[\d.]+) \|$", funnel, re.M) if m[1] in F.FEATURES}
    generated = re.search(r"^Generated (\d{4}-\d{2}-\d{2})\.", text, re.M)
    # A shortlisted founder without a verified quote shows the closest sentence to the thesis: keep it, by lead id
    order, passages = [l["id"] for l in shortlist], {}
    for block in text.split("\n### ")[1:]:
        ref = re.search(r"run\.py label (\S+) yes", block)
        quote = re.search(r"^> (.*)\n> — (\S+) \(closest sentence to the thesis\)$", block, re.M)
        if ref and quote:
            lead_id = order[int(ref[1]) - 1] if ref[1].isdigit() and int(ref[1]) <= len(order) else ref[1]
            passages[lead_id] = [{"text": quote[1], "url": quote[2]}]
    if not counts or len(weights) != len(F.FEATURES) or not generated:
        sys.exit(f"Could not read the funnel counts and weights from {path}. Run: python run.py rank --thesis {th.path.name}")
    return {"generated": generated[1], "counts": counts, "notes": notes, "wnote": wnote, "weights": weights, "passages": passages}
