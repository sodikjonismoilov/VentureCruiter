"""Turn the lead funnel's shortlist into outreach records (the shape of sample_records.json).

Usage, from outreach/:
    python3 from_funnel.py                                        # example_fund, fit >= 3
    python3 from_funnel.py ../lead-funnel/out/founders/my_fund --min-fit 2
Writes funnel_records.json, ready for:
    curl -s -X POST localhost:5001/drafts -H 'Content-Type: application/json' -d @funnel_records.json
"""
import argparse
import json
import re
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

HERE = Path(__file__).resolve().parent
FUNNEL = HERE.parent / "lead-funnel"
DEFAULT = FUNNEL / "out" / "founders" / "example_fund"


def load_thesis(run_dir, dossiers):
    """Full fund thesis: the thesis TOML if found (theses/fund/<run name>.toml), else dossiers.json."""
    toml_path = FUNNEL / "theses" / "fund" / f"{run_dir.name}.toml"
    if tomllib and toml_path.exists():
        t = tomllib.loads(toml_path.read_text())
        name, one_liner, body, beliefs = t.get("fund_name", ""), t.get("one_liner", ""), t.get("thesis", ""), t.get("beliefs", [])
    else:
        name, one_liner, body, beliefs = dossiers.get("fund", ""), dossiers.get("thesis", ""), "", dossiers.get("beliefs", [])
    text = f"{name}: {one_liner}".strip(": ").strip()
    if body.strip():
        text += "\n" + " ".join(body.split())
    beliefs = [b if isinstance(b, str) else b.get("text", "") for b in beliefs]
    if beliefs:
        text += "\nBeliefs:\n" + "\n".join(f"- {b}" for b in beliefs if b)
    return text


def to_record(lead, dossier, thesis):
    j = lead.get("judgment") or {}
    verified = bool(j.get("quote_verified"))
    # The judge's `why` is an internal memo ("probably isn't worth a meeting"), so it never goes
    # into an email. Use what they build and the beliefs they share with the fund instead.
    what = (j.get("what_they_build") or "").strip()
    shared = [s for s in j.get("shared_beliefs") or [] if isinstance(s, str)]
    why = what + (" Shared beliefs: " + "; ".join(shared) if shared else "")
    return {
        # The judge picks the right person to contact; lead.person is just the first officer on the
        # Form D, which is sometimes the CFO, CTO or lawyer.
        "founder_name": (j.get("contact") or lead.get("person") or "").strip(),
        "company": lead.get("company") or "",
        "website": lead.get("website") or "",
        "why": why,
        # Only a quote the funnel verified word for word against the page goes into an email.
        "quote": j.get("quote", "") if verified else "",
        "quote_url": j.get("quote_url", "") if verified else "",
        "openers": [o for o in (dossier or {}).get("conversation_openers") or [] if isinstance(o, str)][:3],
        "thesis": thesis,
        "lead_id": lead.get("id"),
        "fit": j.get("fit"),
    }


def build_records(run_dir, min_fit=3, skip=()):
    """Outreach records for a funnel run folder (out/founders/<fund>), best-ranked first."""
    return build_with_details(Path(run_dir), min_fit, skip)[0]


def build_with_details(run_dir, min_fit, skip):
    """build_records, plus what was left out, the loaded leads and the shortlist order (for the CLI and the API)."""
    leads = {l["id"]: l for l in json.loads((run_dir / "leads.json").read_text())}
    shortlist = json.loads((run_dir / "last_rank.json").read_text())
    dpath = run_dir / "dossiers.json"
    dossiers = json.loads(dpath.read_text()) if dpath.exists() else {}
    by_lead = {d.get("lead_id"): d for d in dossiers.get("founders") or []}
    thesis = load_thesis(run_dir, dossiers)

    exclusions = []
    toml_path = FUNNEL / "theses" / "fund" / f"{run_dir.name}.toml"
    if tomllib and toml_path.exists():
        exclusions = tomllib.loads(toml_path.read_text()).get("exclusions", [])

    records, low_fit, unusable, skipped = [], [], [], []
    for lead_id in shortlist:
        lead = leads.get(lead_id)
        if not lead:
            unusable.append(lead_id)
            continue
        if lead_id in skip:
            skipped.append(lead.get("company") or lead_id)
            continue
        rec = to_record(lead, by_lead.get(lead_id), thesis)
        # The funnel's exclusion filter can miss these (e.g. a crypto company), so warn using the
        # judge's own words. A hit is a warning, not a drop: "serves oil & gas customers" isn't an oil company.
        j = lead.get("judgment") or {}
        text = " ".join([j.get("why", ""), j.get("what_they_build", "")] + [str(c) for c in j.get("concerns") or []]).lower()
        rec["exclusion_hits"] = [e for e in exclusions if re.search(r"\b" + re.escape(e.lower()) + r"\b", text)]
        if (rec["fit"] or 0) < min_fit:
            low_fit.append(f"{rec['company']} (fit {rec['fit']})")
        elif not rec["company"] or not rec["why"] or rec["why"].lower().startswith("unknown"):
            unusable.append(lead_id)
        else:
            records.append(rec)
    return records, {"low_fit": low_fit, "skipped": skipped, "unusable": unusable,
                     "leads": leads, "shortlist": shortlist}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir", nargs="?", default=str(DEFAULT))
    ap.add_argument("--min-fit", type=int, default=3, help="drop leads the judge rated below this (1-5)")
    ap.add_argument("--skip", nargs="*", default=[], help="lead ids to leave out, e.g. co:0001962104")
    args = ap.parse_args()

    records, info = build_with_details(Path(args.run_dir).resolve(), args.min_fit, args.skip)
    low_fit, skipped, unusable = info["low_fit"], info["skipped"], info["unusable"]

    out = HERE / "funnel_records.json"
    out.write_text(json.dumps({"records": records}, indent=2))
    print(f"{len(records)} records -> {out.name} (min fit {args.min_fit})")
    for r in records:
        warn = f"  WARNING exclusion words: {r['exclusion_hits']}" if r["exclusion_hits"] else ""
        print(f"  fit {r['fit']}  {r['lead_id']}  {r['founder_name']:<18} {r['company']:<28} "
              f"quote: {'yes' if r['quote'] else 'no'}{warn}")
    print(f"dropped for low fit: {len(low_fit)}; skipped: {len(skipped)}; unusable: {len(unusable)}")


if __name__ == "__main__":
    main()
