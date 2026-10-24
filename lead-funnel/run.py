#!/usr/bin/env python3
"""Lead funnel. Two modes, picked from the thesis file you pass:

  Fund thesis  (has round_size_usd)  -> founder sourcing: startups raising now and builders before the round
  Startup thesis (has fund_size_usd) -> investor matching: venture firms that think like the founder

  python run.py build                      download SEC data; build firms and startups (rerun quarterly)
  python run.py rank [--thesis PATH]       run the funnel for that thesis (default theses/fund/example_fund.toml)
        [--no-claude] [--no-akta]          skip the Claude judge / skip akta.pro entirely
        [--akta-list N]                    founders: add up to N companies from akta.pro List Generation (paid)
        [--akta-new N]                     investors: allow up to N new paid akta.pro firm lookups
  python run.py investors [--thesis PATH]  same as rank, defaulting to theses/startup/vet_clinics.toml
  python run.py label <rank|id> yes|no ["why"] [--thesis PATH]   teach it your taste for that thesis
  python run.py show <rank|id> [--thesis PATH]                   print everything known about one lead
  python run.py report [--thesis PATH]     founders: rewrite report.md from the saved leads.json (no funnel run, no API calls)
  python run.py dossier [--thesis PATH]    founders: sourced JSON dossier on each shortlisted founder (Claude)
        [--akta-profiles]                  also buy akta.pro leadership profiles (1 credit per company)
  python run.py chat [--thesis PATH]       chat with an assistant that answers from the dossiers
        [--ask "question"]                 ask one question and exit
  python run.py akta-budget                akta.pro credits used this month and what is left
  python run.py akta-sync <remaining>      set the ledger to match the remaining balance on your akta.pro dashboard

Results go to out/<mode>/<thesis name>/; labels and learned weights to data/labels/ and data/features/.
"""
import argparse
import csv
import json
import os
import sys
import tomllib
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA, OUT = HERE / "data", HERE / "out"


def load_env():
    for p in (HERE / ".env", HERE.parent / ".env"):
        if p.exists():
            for line in p.read_text().splitlines():
                if "=" in line and not line.lstrip().startswith("#"):
                    k, v = line.split("=", 1)
                    v = v.strip()
                    if v[:1] in ('"', "'") and v[0] in v[1:]:
                        v = v[1:v.index(v[0], 1)]  # quoted value; anything after the closing quote is a comment
                    else:
                        v = "" if v.startswith("#") else v.split(" #", 1)[0].split("\t#", 1)[0].strip()
                    if v:
                        os.environ.setdefault(k.strip(), v)


def universe():
    path = DATA / "universe.json"
    if not path.exists():
        sys.exit("No universe yet. Run: python run.py build")
    return json.loads(path.read_text())


DEFAULT_FUND = "theses/fund/example_fund.toml"
DEFAULT_STARTUP = "theses/startup/vet_clinics.toml"


class Thesis:
    """A thesis file, its mode, and the per-thesis files that go with it."""

    def __init__(self, arg):
        p = Path(arg).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p if (Path.cwd() / p).exists() else HERE / p  # where you ran from, then this folder
        if not p.is_file():
            sys.exit(f"Thesis file not found: {arg}")
        self.path = p.resolve()
        self.name = self.path.stem
        try:
            self.t = tomllib.loads(self.path.read_text())
        except tomllib.TOMLDecodeError as e:
            sys.exit(f"{self.path.name} is not valid TOML: {e}")
        if "round_size_usd" in self.t:
            self.mode, need, example = "founders", ("one_liner", "thesis", "beliefs", "keywords", "round_size_usd"), DEFAULT_FUND
        elif "fund_size_usd" in self.t:
            self.mode, need, example = "investors", ("one_liner", "thesis", "beliefs", "keywords", "fund_size_usd"), DEFAULT_STARTUP
        else:
            sys.exit(f"{self.path.name}: add round_size_usd (a fund looking for founders) or fund_size_usd (a startup looking for investors).")
        missing = [k for k in need if k not in self.t]
        if missing:
            sys.exit(f"{self.path.name} is missing: {', '.join(missing)} (see {example} for the format)")
        self.out = OUT / self.mode / self.name
        self.labels = DATA / "labels" / self.mode / f"{self.name}.csv"
        self.features = DATA / "features" / self.mode / f"{self.name}.json"
        self.ranks = self.out / "last_rank.json"

    def load(self):
        return self.t


def resolve(ref, th):
    if ref.isdigit():
        ranks = json.loads(th.ranks.read_text()) if th.ranks.exists() else []
        if not 1 <= int(ref) <= len(ranks):
            sys.exit(f"No lead #{ref} in the last shortlist for {th.name}. Run: python run.py rank --thesis {th.path.name}")
        return ranks[int(ref) - 1]
    return ref


def cmd_build(args):
    from funnel.sec import build_universe
    ua = os.environ.get("SEC_USER_AGENT")
    if not ua:
        sys.exit('Set SEC_USER_AGENT in .env, e.g. SEC_USER_AGENT="Your Name you@school.edu". The SEC requires a contact.')
    universe = build_universe(DATA, ua, args.quarters)
    from funnel.startups import build_startups
    build_startups(DATA, universe)


def cmd_label(args):
    th = Thesis(args.thesis)
    fid = resolve(args.ref, th)
    path = th.labels
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = list(csv.DictReader(open(path))) if path.exists() else []
    rows = [r for r in rows if r["firm_id"] != fid] + [{"firm_id": fid, "label": args.label, "note": args.note or ""}]
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, ["firm_id", "label", "note"])
        w.writeheader()
        w.writerows(rows)
    if th.mode == "founders":
        lead = next((l for l in json.loads((th.out / "leads.json").read_text()) if l["id"] == fid), {}) if (th.out / "leads.json").exists() else {}
        name = " · ".join(x for x in (lead.get("person"), lead.get("company")) if x) or fid
    else:
        name = next((f["name"] for f in universe()["firms"] if f["id"] == fid), fid)
    print(f"Labeled {name} as {args.label} for {th.name}. {len(rows)} labels for this thesis. "
          f"Rerun `python run.py rank --thesis {th.path.name}` to apply.")


def cmd_show(args):
    th = Thesis(args.thesis)
    fid = resolve(args.ref, th)
    if th.mode == "founders":
        lead = next((l for l in json.loads((th.out / "leads.json").read_text()) if l["id"] == fid), None) if (th.out / "leads.json").exists() else None
        if not lead:
            sys.exit(f"Unknown lead {fid}. Run: python run.py rank --thesis {th.path.name}")
        print(json.dumps(lead, indent=2))
        return
    f = next((f for f in universe()["firms"] if f["id"] == fid), None)
    if not f:
        sys.exit(f"Unknown firm {fid}")
    feats = json.loads(th.features.read_text()).get(fid, {}) if th.features.exists() else {}
    print(json.dumps({**{k: f[k] for k in ("id", "name", "city", "state", "website", "aum", "n_vc_funds", "source")},
                      "people": list(f["people"].values())[:20], "funds": f["funds"][:8], "board_seats": f["board_seats"][:30], "features": feats}, indent=2))


def cmd_akta_budget(args):
    from funnel import akta
    led = akta.Ledger(DATA / "akta")
    print(f"akta.pro credits used this month: {led.used():g} of {akta.MONTHLY_CREDITS:g}")
    print(f"usable left: {led.left():g} (keeps {akta.RESERVE_CREDITS:g} in reserve) = about {int(led.left() // 7)} new lookups at 7 credits")
    for e in led.data["entries"][-5:]:
        print(f"  {e['at']}  {e['credits']:>7.1f} credits  {e['note']}")


def _founder_results(args):
    th = Thesis(args.thesis or DEFAULT_FUND)
    if th.mode != "founders":
        sys.exit("Dossiers and chat are for fund theses (founder sourcing).")
    if not (th.out / "leads.json").exists() or not th.ranks.exists():
        sys.exit(f"No shortlist yet. Run: python run.py rank --thesis {th.path}")
    leads = {l["id"]: l for l in json.loads((th.out / "leads.json").read_text())}
    return th, th.load(), json.loads(th.ranks.read_text()), leads


def cmd_dossier(args):
    from funnel import dossier
    th, t, ids, leads = _founder_results(args)
    client = None
    if args.akta_profiles:
        from funnel.akta import Akta
        key = os.environ.get("AKTA_API_KEY") or sys.exit("--akta-profiles needs AKTA_API_KEY in .env.")
        client = Akta(key, DATA / "akta", allow_paid=True)
        with_site = sum(1 for i in ids if leads[i].get("website"))
        print(f"akta.pro leadership profiles: up to {with_site} companies at 1 credit each (max {with_site} credits). "
              f"This month: {client.ledger.used():g} used, {client.ledger.left():g} usable left. Cached profiles are free.")
    print(f"Writing dossiers for {len(ids)} founders via Claude (cached dossiers are free; new ones are about $0.08-0.15 each)…")
    results = dossier.build(th, t, DATA, ids, leads, client)
    errs = [(lid, r["error"]) for lid, r, _ in results if "error" in r]
    for lid, r, n in results:
        if "error" not in r:
            print(f"  #{r['rank']:>2} {r['person']['name'][:24]:<24} {r['company']['name'][:28]:<28} fit {r['fit_score']}/5  {n} sources  "
                  f"{len(r['background']) + len(r['founder_signals'])} facts" + (f", {r['dropped_unsourced_facts']} unsourced dropped" if r["dropped_unsourced_facts"] else ""))
    for lid, e in errs:
        print(f"  {lid}: not written ({e})")
    if client:
        print(f"akta.pro: {client.credits:g} credits this run; {client.ledger.left():g} usable left.")
    print(f"\nWrote {th.out / 'dossiers.json'} and {th.out / 'dossiers'}/")


def cmd_chat(args):
    from funnel import dossier
    th = Thesis(args.thesis or DEFAULT_FUND)
    path = th.out / "dossiers.json"
    if not path.exists():
        sys.exit(f"No dossiers yet. Run: python run.py dossier --thesis {th.path}")
    bundle = json.loads(path.read_text())
    complete, via = dossier.completer()
    history, last = [], None
    questions = [args.ask] if args.ask else None
    print(f"{bundle['fund']}: {len(bundle['founders'])} founder dossiers. Answers via {via}; each question costs a few cents.")
    if not questions:
        print("Ask about any founder by name, company or rank (e.g. 'Compare #2 and #4', 'What should I ask Lockchain?'). Empty line to quit.\n")
    while True:
        q = questions.pop(0) if questions is not None and questions else (None if questions is not None else input("you> ").strip())
        if not q:
            break
        answer, last = dossier.reply(history, q, bundle, last, complete)
        print(f"\nassistant> {answer}\n")
        history += [{"role": "user", "content": q}, {"role": "assistant", "content": answer}]
        history = history[-12:]  # keep the last six exchanges


def cmd_akta_sync(args):
    """The dashboard is the truth; record one adjustment so this month's count matches it."""
    from funnel import akta
    led = akta.Ledger(DATA / "akta")
    target = akta.MONTHLY_CREDITS - args.remaining
    if target < 0:
        sys.exit(f"Remaining {args.remaining:g} is more than the monthly allowance {akta.MONTHLY_CREDITS:g}. Set AKTA_MONTHLY_CREDITS in .env.")
    delta = round(target - led.used(), 2)
    if delta:
        led.add(delta, f"synced to akta.pro dashboard: {args.remaining:g} remaining")
    print(f"Ledger was {target - delta:g} used; dashboard says {target:g} used ({args.remaining:g} remaining). Adjusted by {delta:+g}.")
    print(f"Usable now: {led.left():g} credits (keeps {akta.RESERVE_CREDITS:g} in reserve).")


def money(v):
    return "undisclosed" if not v else f"${v / 1e9:.1f}B" if v >= 1e9 else f"${v / 1e6:.0f}M"


def cmd_rank(args):
    th = Thesis(args.thesis or (DEFAULT_STARTUP if args.cmd == "investors" else DEFAULT_FUND))
    print(f"Thesis: {th.path} ({'fund looking for founders' if th.mode == 'founders' else 'startup looking for investors'})  ->  {th.out}")
    if th.mode == "founders":
        if args.akta_new:
            sys.exit("--akta-new is for investor matching; for founders use --akta-list N.")
        universe()  # needs `build` first
        from funnel.founder_pipeline import run as run_founders
        return run_founders(th, th.load(), args, DATA, HERE)
    if args.akta_list:
        sys.exit("--akta-list is for founder sourcing; for investors use --akta-new N.")
    return cmd_investors(args, th)


def cmd_report(args):
    th = Thesis(args.thesis or DEFAULT_FUND)
    if th.mode != "founders":
        sys.exit("report re-renders founder sourcing results; pass a fund thesis (one with round_size_usd).")
    from funnel.founder_pipeline import write_report
    write_report(th, th.load())


def cmd_investors(args, th):
    from funnel import score as S
    from funnel.web import enrich as web_enrich

    t = th.load()
    run = {"sourced": 1000, "screen": 200, "deep": 50, "shortlist": 15, "judge_effort": "high", **t.get("run", {})}
    today = date.today()
    firms = universe()["firms"]
    by_id = {f["id"]: f for f in firms}
    labels = S.load_labels(th.labels)
    connections = S.load_connections(HERE / "connections.csv")
    saved = json.loads(th.features.read_text()) if th.features.exists() else {}
    weights, wnote = S.learned_weights({i: {"features": v} for i, v in saved.items()}, labels)
    counts, notes = [("Venture firms in SEC data", len(firms))], []

    # Stage 1 · sourcing: hard rules, then structured fit only (no web calls yet)
    S.base_features(firms, t, connections, today)
    pool = [f for f in firms if S.hard_filter(f, t, today)]
    counts.append(("Pass hard filters (stage, size, recency, geography, contactable)", len(pool)))
    for f in pool:
        f["score"] = S.stage_score(f, "source", weights)
    sourced = sorted(pool, key=lambda f: -f["score"])[: run["sourced"]]
    counts.append(("Sourced: best structured fit", len(sourced)))

    # Stage 2 · screen: read homepages, text similarity to your thesis, exclusions and conflicts
    print(f"Stage 2: reading homepages for {sum(1 for f in sourced if f['website'])} firms…")
    web_enrich(sourced, DATA / "web", deep=False)
    S.text_similarity(sourced, t, labels)
    for f in sourced:
        f["excluded_by"], f["conflicts"], f["possible_conflicts"] = S.penalty(f, t)
        f["score"] = S.stage_score(f, "screen", weights)
    screened = sorted(sourced, key=lambda f: -f["score"])[: run["screen"]]
    counts.append(("Screened: homepage language + portfolio fit", len(screened)))

    # Stage 3 · deep: key pages, akta.pro for the top, warm paths
    print(f"Stage 3: reading portfolio, thesis and blog pages for {len(screened)} firms…")
    web_enrich(screened, DATA / "web", deep=True)
    akta_key = os.environ.get("AKTA_API_KEY")
    if akta_key and not args.no_akta:
        from funnel import akta
        top = sorted(screened, key=lambda f: -f["score"])
        if args.akta_new:
            led = akta.Ledger(DATA / "akta")
            per = sum(akta.SECTION_CREDITS[x] for x in akta.TEXT_SECTIONS + [akta.PORTFOLIO_SECTION])
            print(f"Stage 3: akta.pro: up to {args.akta_new} new lookups at most {per:g} credits each "
                  f"(max {per * args.akta_new:g}). This month: {led.used():g} used, {led.left():g} usable left.")
        else:
            print("Stage 3: akta.pro: cached data only, no paid calls (use --akta-new N to allow new lookups).")
        res = akta.enrich(top, akta_key, DATA / "akta", args.akta_new)
        notes.append(f"akta.pro: {res['new_calls']} new paid calls this run ({res['credits']:g} credits). This month: {res['used']:g} used, "
                     f"{res['left']:g} of {res['limit']:g} usable credits left."
                     + (f" Stopped: {res['stopped']}." if res["stopped"] and args.akta_new else "")
                     + (f" Errors: {'; '.join(res['errors'][:2])}" if res["errors"] else ""))
    else:
        notes.append("akta.pro: off (set AKTA_API_KEY in .env)." if not akta_key else "akta.pro: skipped (--no-akta).")
    vec, profile = S.text_similarity(screened, t, labels)
    for f in screened:
        f["features"]["board_fit"] = S.board_fit(f, t)
        f["excluded_by"], f["conflicts"], f["possible_conflicts"] = S.penalty(f, t)
        f["score"] = S.stage_score(f, "deep", weights)
    deep = sorted(screened, key=lambda f: -f["score"])[: run["deep"]]
    counts.append(("Deep: key pages, investments, warm paths", len(deep)))

    # Stage 4 · judge: Claude reads each finalist's evidence against your thesis and past labels
    from funnel.judge import provider, judge_all
    which = None if args.no_claude else provider()
    if which:
        via = "Anthropic API" if which == "anthropic" else "Nicrron gateway"
        print(f"Stage 4: Claude judging {len(deep)} finalists via {via}…")
        judge_all(deep, S.thesis_text(t), labels, by_id, DATA / "judge", effort=run["judge_effort"])
        for f in deep:
            j = f.get("judgment") or {}
            if "alignment" in j:
                f["features"]["claude"] = (j["alignment"] - 1) / 4
                if j.get("conflict"):
                    f["conflicts"] = f["conflicts"] or ["Claude flagged a competitor in the portfolio"]
        errs = [f["judgment"]["error"] for f in deep if "error" in (f.get("judgment") or {})]
        how = f"{run['judge_effort']} effort" if which == "anthropic" else "anthropic/claude-opus-5-5 via Nicrron, default effort"
        notes.append(f"Claude Opus 5.5 ({via}, {how}): judged {len(deep) - len(errs)} of {len(deep)}." + (f" Errors: {errs[0]}" if errs else ""))
    else:
        notes.append("Claude: off (set ANTHROPIC_API_KEY or NICRRON_API_KEY). Final ranking uses scores only; quotes are the closest sentences from each site.")
    for f in deep:
        f["score"] = S.stage_score(f, "final", weights)
        f["passages"] = S.best_passages(f, vec, profile)
        f["partner"] = S.pick_partner(f, t)
    ranked = sorted(deep, key=lambda f: -f["score"])
    shortlist = [f for f in ranked if not f["conflicts"]][: run["shortlist"]]
    conflicted = [f for f in ranked if f["conflicts"]]
    counts.append(("Shortlist", len(shortlist)))

    # Persist features so labels can train weights later
    for f in sourced:
        saved[f["id"]] = f["features"]
    th.features.parent.mkdir(parents=True, exist_ok=True)
    th.features.write_text(json.dumps(saved))
    th.out.mkdir(parents=True, exist_ok=True)
    th.ranks.write_text(json.dumps([f["id"] for f in shortlist]))
    write_csv(th.out / "sourced.csv", sourced, screened, deep, shortlist)
    write_csv(th.out / "shortlist.csv", shortlist, screened, deep, shortlist)
    write_report(th.out / "report.md", t, counts, notes, wnote, weights, shortlist, conflicted, labels)
    print("\n".join(f"  {n:>6,}  {label}" for label, n in counts))
    print(f"\nWrote {th.out / 'report.md'}")


def write_csv(path, rows, screened, deep, shortlist):
    ids = lambda xs: {f["id"] for f in xs}
    s2, s3, s4 = ids(screened), ids(deep), ids(shortlist)
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["rank", "firm_id", "name", "partner", "city", "state", "website", "fund_size", "stage_reached", "score", *__import__("funnel.score", fromlist=["FEATURES"]).FEATURES, "conflicts", "excluded_by"])
        for i, f in enumerate(rows, 1):
            stage = "shortlist" if f["id"] in s4 else "deep" if f["id"] in s3 else "screen" if f["id"] in s2 else "sourced"
            w.writerow([i, f["id"], f["name"], (f.get("partner") or ("",))[0], f["city"], f["state"], f["website"], f.get("fund_size") or "", stage, f["score"],
                        *[f["features"].get(k, "") for k in __import__("funnel.score", fromlist=["FEATURES"]).FEATURES],
                        "; ".join(f.get("conflicts") or []), f.get("excluded_by") or ""])


def write_report(path, t, counts, notes, wnote, weights, shortlist, conflicted, labels):
    from funnel.score import FEATURES, VEHICLE as S_VEHICLE
    L = [f"# Investor shortlist: {t['one_liner']}", "", f"Generated {date.today().isoformat()}. Data: SEC Form ADV and Form D bulk files, firm websites"
         + (", akta.pro" if any(f.get("akta") for f in shortlist) else "") + (", Claude" if any("alignment" in (f.get("judgment") or {}) for f in shortlist) else "") + ".", "",
         "## Funnel", "", "| Stage | Firms |", "|---|---:|"] + [f"| {label} | {n:,} |" for label, n in counts] + ["", *[f"- {n}" for n in notes],
         f"- Weights: {wnote}.", "", "| Feature | Weight |", "|---|---:|"] + [f"| {k} | {weights[k]:.2f} |" for k in FEATURES] + ["", "## Leads", ""]
    for i, f in enumerate(shortlist, 1):
        j = f.get("judgment") or {}
        partner, title = f["partner"]
        L += [f"### {i}. {f['name']} · score {f['score']:.2f}" + (" · ✓ you liked this" if labels.get(f["id"], (0,))[0] > 0 else ""), ""]
        L.append(f"**Contact:** {partner or 'partner unknown'}" + (f" ({title})" if title else "") + f" · {f['city'] or ''} {f['state']}".rstrip() + (f" · {f['website']}" if f["website"] else ""))
        if j.get("why"):
            L.append(f"\n**Why (Claude, alignment {j['alignment']}/5):** {j['why']}")
        if j.get("quote"):
            src = j["quote_url"] or ""
            if src.startswith("akta.pro"):
                L.append(f"\n> {j['quote']}\n> — akta.pro profile (third-party description, not the firm's own words)")
            else:
                L.append(f"\n> {j['quote']}\n> — [{src or 'their site'}]({src}) (verified on page)")
        elif f.get("passages"):
            p = f["passages"][0]
            L.append(f"\n> {p['text']}\n> — [{p['url']}]({p['url']}) (closest sentence to your thesis)")
        if j.get("shared_beliefs"):
            L.append("\n**Shared beliefs:** " + "; ".join(j["shared_beliefs"]))
        main = [x for x in f["funds"] if not S_VEHICLE.search(x["name"])]
        fund = (main or f["funds"] or [None])[0]
        ev = [f"latest fund {fund['name']} ({money(fund['amount'])}, filed {fund['date']})" if fund else "no fund filing in the window",
              f"private fund assets {money(f['aum'])}" if f["aum"] else ""]
        seats = [s for s in f["board_seats"] if s["industry"] in set(t.get("industries", []))][:5]
        if seats:
            ev.append("board seats in your space: " + ", ".join(f"{s['company']} ({s['person']})" for s in seats))
        if f.get("portfolio"):
            seen = list(dict.fromkeys((p["company"], p["round"], p["lead"]) for p in f["portfolio"]))[:6]
            ev.append("akta.pro investments: " + ", ".join(c + (f" ({', '.join(x for x in (r, 'lead' if l else '') if x)})" if r or l else "") for c, r, l in seen))
        L.append("\n**Evidence:** " + "; ".join(e for e in ev if e) + ".")
        if f["warm_why"]:
            L.append(f"\n**Warm path:** {f['warm_why']}")
        risks = (j.get("concerns") or []) + [f"possible conflict: {c} mentioned on site" for c in f.get("possible_conflicts") or []] + ([f["excluded_by"]] if f.get("excluded_by") else [])
        if risks:
            L.append("\n**Watch out:** " + "; ".join(risks))
        L.append("\n**Score:** " + " · ".join(f"{k} {f['features'][k]:.2f}" for k in FEATURES if k in f["features"]))
        L.append(f"\n`python run.py label {i} yes \"why\"` or `python run.py label {i} no \"why\"`\n")
    if conflicted:
        L += ["## Dropped for conflicts", ""] + [f"- **{f['name']}**: {'; '.join(f['conflicts'])}" for f in conflicted[:15]]
    path.write_text("\n".join(L) + "\n")


def main():
    load_env()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--quarters", type=int, default=8)
    th_arg = argparse.ArgumentParser(add_help=False)
    th_arg.add_argument("--thesis", default=None, metavar="PATH", help=f"thesis file (default {DEFAULT_FUND})")
    for cmd in ("rank", "investors"):
        r = sub.add_parser(cmd, parents=[th_arg]); r.add_argument("--no-claude", action="store_true")
        r.add_argument("--no-akta", action="store_true")
        r.add_argument("--akta-new", type=int, default=0, metavar="N", help="investors: allow up to N new paid akta.pro lookups (default 0)")
        r.add_argument("--akta-list", type=int, default=0, metavar="N", help="founders: add up to N companies from akta.pro List Generation (paid)")
    d = sub.add_parser("dossier", parents=[th_arg]); d.add_argument("--akta-profiles", action="store_true", help="also buy akta.pro leadership profiles (1 credit each)")
    c = sub.add_parser("chat", parents=[th_arg]); c.add_argument("--ask", metavar="QUESTION", help="ask one question and exit")
    sub.add_parser("akta-budget")
    sy = sub.add_parser("akta-sync"); sy.add_argument("remaining", type=float, help="remaining credits shown on your akta.pro dashboard")
    l = sub.add_parser("label", parents=[th_arg]); l.add_argument("ref"); l.add_argument("label", choices=["yes", "no"]); l.add_argument("note", nargs="?")
    s = sub.add_parser("show", parents=[th_arg]); s.add_argument("ref")
    sub.add_parser("report", parents=[th_arg])
    args = ap.parse_args()
    if getattr(args, "thesis", "x") is None and args.cmd in ("label", "show"):
        args.thesis = DEFAULT_FUND
    {"build": cmd_build, "rank": cmd_rank, "investors": cmd_rank, "label": cmd_label, "show": cmd_show, "akta-budget": cmd_akta_budget, "akta-sync": cmd_akta_sync,
     "dossier": cmd_dossier, "chat": cmd_chat, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    main()
