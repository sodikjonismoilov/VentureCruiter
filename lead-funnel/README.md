# Lead funnel

A fund writes down its thesis. The funnel finds the 10–20 founders who best fit it, including people who haven't raised yet, and explains each one with evidence, a quote, concerns and a score the fund can tune with yes/no labels.

```
~14,600 leads
  14,487 startups raising now (SEC Form D, last 2 years, founders named on the filing)
  + builders before the round (GitHub, Show HN, arXiv, searched with the fund's terms)
  + optional akta.pro List Generation matches (paid)
→ hard filters: recent filing, round size, incorporated recently, a corporation, on-thesis words   ~2,000
→ sourced: stage, recency, relevance, traction, founder signals                                  1,000
→ screened: language match to the thesis                                                          200
→ deep: startup websites found and read, GitHub READMEs, warm paths                                50
→ shortlist: Claude judges fit with the fund's beliefs and founder quality; quotes checked       10–20
```

A third of every stage is kept for builders who haven't raised yet (`pre_round_share`), since finding a founder before the round is the point. On the final shortlist those places only go to builders Claude rates fit 3/5 or better; weaker builders compete on score. Finalists without a Claude judgment are listed in the report but kept off the shortlist.

The tool also runs the other way: a **startup thesis** finds the venture firms that think like the founder (see [Investor matching](#investor-matching)).

## Setup

Requires Python 3.12 or newer (`funnel/judge.py` uses nested f-strings).

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python run.py build
```

`build` downloads about 40 MB of SEC data (8 quarters of Form D, plus Form ADV) and builds the startup and venture-firm lists. It takes about a minute; rerun it once a quarter.

### Keys (`.env`)

| Variable | Needed for | Notes |
|---|---|---|
| `SEC_USER_AGENT` | `build` | Your name and email; the SEC requires a contact |
| `NICRRON_API_KEY` or `ANTHROPIC_API_KEY` | Claude judge (optional) | Both run Claude Opus 5.5; Anthropic wins if both are set. `JUDGE_PROVIDER` forces one. |
| `AKTA_API_KEY` | akta.pro (optional) | Free company search for websites; paid list generation only with a flag |
| `GITHUB_TOKEN` | (optional) | Raises GitHub's rate limit; without it, builder search is slower and capped |
| `AKTA_MONTHLY_CREDITS`, `AKTA_RESERVE_CREDITS` | (optional) | Monthly allowance (default 1,250) and credits never spent (default 100) |

`.env` is git-ignored. Never put keys in `.env.example` or any committed file.

## Commands

Run from this folder. `rank` picks its mode from the thesis file: a fund thesis (has `round_size_usd`) sources founders; a startup thesis (has `fund_size_usd`) matches investors.

| Command | What it does | Cost |
|---|---|---|
| `run.py rank --no-claude` | Founder sourcing on free data, default fund thesis | Free |
| `run.py rank` | Same, with Claude judging the final 50 | About $3–4 for a new thesis; free if cached |
| `run.py rank --akta-list 100` | Also pull up to 100 companies from akta.pro List Generation | Up to 24 credits (1.5 + 2.5 + 0.2 per company) |
| `run.py rank --thesis theses/fund/my_fund.toml` | Any fund thesis | as above |
| `run.py label 3 yes "why"` | Label lead #3 from the last shortlist for that thesis | Free |
| `run.py show 3` | Everything known about lead #3 | Free |
| `run.py report` | Rewrite `report.md` from the saved `leads.json`, e.g. after changing `min_shortlist_fit`; no funnel run | Free, no API calls, seconds |
| `run.py dossier` | Sourced JSON dossier on each shortlisted founder, for a chatbot | About $1–2 via Claude for 15; free if cached |
| `run.py dossier --akta-profiles` | Also add akta.pro leadership profiles | Up to 1 credit per company |
| `run.py chat` | Ask questions about the shortlisted founders, answered from the dossiers | About $0.03–0.10 per question |
| `run.py chat --ask "Compare #2 and #4"` | One question, then exit | About $0.03–0.10 |
| `run.py investors --thesis theses/startup/vc_tools.toml` | Investor matching for a startup thesis | Free without Claude |
| `run.py akta-budget` | akta.pro credits used this month and what's left | Free |
| `run.py akta-sync 924` | Set the ledger to match the remaining balance on your akta.pro dashboard | Free |
| `export_results.py --thesis PATH` | All results for a thesis in one text file | Free, no API calls |

Pass the same `--thesis` to `label`, `show` and `export_results.py`. Without it they use `theses/fund/example_fund.toml`.

## Writing a fund thesis

Copy [theses/fund/example_fund.toml](theses/fund/example_fund.toml) (an example: AI-native software for regulated industries).

| Field | How it's used |
|---|---|
| `fund_name`, `one_liner`, `thesis` | Matched against each lead's evidence and given to Claude |
| `beliefs` | **Matters most.** Claude looks for founders whose work supports these |
| `keywords` | Whole-word matches in company names, repos, launches, papers and websites |
| `search_terms` | Queries for GitHub, Show HN and arXiv (about six) |
| `industries` | Form D industry groups that count as on-thesis |
| `portfolio`, `competitors` | Overlap with these is flagged for review and kept off the shortlist |
| `exclusions` | Leads whose language is dominated by these are marked off-thesis |
| `round_size_usd` | Round sizes the fund leads or joins; much larger rounds are dropped |
| `geo_preferred`, `geo_required` | US state codes: soft preference and hard filter |
| `founded_after`, `max_months_since_filing` | Drops older companies and stale filings |
| `entity_types` | Form D entity types kept (default `["Corporation"]`; LLCs here are mostly vehicles) |
| `akta_query` or `akta_filters` | What akta.pro List Generation searches for (only with `--akta-list`) |
| `[run]` | Stage sizes, shortlist length, `pre_round_share`, `min_builder_fit` (Claude fit a builder needs to use a kept shortlist place, default 3), `min_shortlist_fit` (report only, default 0 = off: founders Claude rates below it, or whose summary names one of the `exclusions`, are listed under "Also considered" instead of the main list; the ranking and `leads.json` don't change), `report_exclusions` (report only: extra words for that exclusion check, never used in scoring), Claude effort (Anthropic only) |

## Results

For `theses/fund/my_fund.toml`:

| File | Contents |
|---|---|
| `out/founders/my_fund/report.md` | Shortlist with briefs: stage, what they build, why meet, quote, evidence, how to reach them, concerns, score |
| `out/founders/my_fund/leads.json` | All 50 finalists with evidence and Claude's judgment |
| `out/founders/my_fund/shortlist.csv`, `sourced.csv` | Shortlist and all 1,000 sourced leads with feature scores |
| `out/founders/my_fund/report_context.json` | Funnel counts, notes, weights and fallback quotes, so `run.py report` can rewrite the report |
| `data/labels/founders/my_fund.csv` | Your yes/no labels for this thesis |

## Founder dossiers and chat

After `rank`, `run.py dossier` gathers more on each shortlisted founder: their other companies and filing history from Form D, the company's team, about and blog pages, GitHub profile and repos, Hacker News profile, other arXiv papers and, with `--akta-profiles`, akta.pro's leadership profiles. Claude then writes a structured dossier per founder:

`summary`, `person`, `co_founders`, `company` (what they build, customers, stage, raised), `background` and `founder_signals` (facts, each with a source), `thesis_fit` (one verdict per fund belief), `fit_score`, `strengths`, `risks`, `open_questions`, `conversation_openers`, `unknowns`, `confidence`, and the list of `sources`.

Every fact must cite a numbered source from the evidence. Facts citing anything else are dropped, and a belief verdict without a valid source becomes `unknown`. The dossier says how many were dropped. The earlier screening judgment is Claude's own summary, so it is not given as evidence; items in older dossiers that relied on it are marked `"unverified": true`.

Dossiers are streamed from Claude: long answers sent in one piece timed out at the Nicrron gateway. They are written two at a time and cached, so rerunning costs nothing unless a founder's evidence changed.

Files: `out/founders/<fund>/dossiers/<lead>.json` (one per founder) and `out/founders/<fund>/dossiers.json` (all of them, with the fund's thesis and beliefs), ready to load into any chatbot. `run.py chat` is a simple one that answers only from the dossiers and cites sources:

| Question | What the chatbot sees |
|---|---|
| Names founders ("What should I ask Lockchain?", "Compare #2 and #4") | Full dossiers for those founders |
| A follow-up ("What are their biggest risks?") | Full dossiers for the founders in the previous answer |
| Names nobody ("Who best fits our compliance belief?") | A compact dossier for every founder: summary, company, fit, belief verdicts with sources, strengths, risks, key facts |

## How it learns your taste

- **Language:** the thesis profile moves toward the words of leads you liked and away from ones you didn't.
- **Weights:** with 2+ yes and 2+ no labels, a logistic regression refits how much each signal counts, blending in fully at about 30 labels.
- **Claude:** your labels and notes go into the judge as examples of the fund's taste.

## Signals

| Signal | Startups raising (Form D) | Builders before the round |
|---|---|---|
| Stage | Round size against `round_size_usd` | Treated as pre-round |
| Traction | Number of investors, share of the round sold | GitHub stars per day, Show HN points |
| Founder | Repeat founder (officer of another startup in the data); venture partner on the board | GitHub followers; also a Form D officer |
| Relevance | Keywords in the company name and website | Keywords in repo, launch or paper text |

Startup websites aren't in Form D. The funnel guesses likely domains from the company name and keeps a site only if the page names the company, then tries akta.pro's free company search. Guessed sites are labeled in the report, and Claude is told to flag a site that looks like a different company.

## Spending

**akta.pro**
- A normal run makes no paid calls. Company Search, used to find websites, is free.
- List Generation runs only with `--akta-list N`, at most 1.5 + 2.5 + 0.2 × N credits. Results are cached, so rerunning the same query is free.
- Before every paid call, its worst-case credits are checked against this month's allowance minus the reserve; if it doesn't fit, nothing is sent.
- Every paid call is logged in `data/akta/ledger.json`. Check with `run.py akta-budget`. The ledger only counts this tool's calls, so compare it with your akta.pro dashboard now and then and run `run.py akta-sync <remaining>` to match.

**Claude**
- Judges the final 50, about $3–4 for a new thesis. Every judgment is cached by its inputs, so rerunning costs nothing unless the thesis, your labels or a lead's evidence changed.
- Quotes are checked against the evidence; any quote not found word for word is dropped.

## Investor matching

The original mode, for a founder looking for investors. Startup theses live in `theses/startup/` and have `fund_size_usd` instead of `round_size_usd`.

```bash
.venv/bin/python run.py investors --thesis theses/startup/vet_clinics.toml --no-claude
```

It ranks about 12,000 venture firms from Form ADV and Form D by fund size, recent funds, board seats in the founder's space, website language and akta.pro portfolio data (`--akta-new N` allows N paid lookups, 7 credits each), then Claude judges shared beliefs. Results go to `out/investors/<name>/`.

## Code layout

| File | Role |
|---|---|
| `run.py` | CLI: build, rank, investors, label, show, akta-budget |
| `funnel/sec.py` | SEC bulk data; venture firms, partners, board seats |
| `funnel/startups.py` | Startups and founders from Form D |
| `funnel/builders.py` | GitHub, Show HN and arXiv builders |
| `funnel/founders.py` | Founder leads, website discovery, features, filters |
| `funnel/founder_pipeline.py` | Founder funnel stages and report |
| `funnel/score.py` | Investor features, text similarity, learning from labels |
| `funnel/web.py` | Website fetching (robots.txt respected), cached |
| `funnel/akta.py` | akta.pro client with the credit ledger and spending guard |
| `funnel/judge.py` | Claude judges for both modes, via Anthropic or Nicrron, with quote checking |
| `export_results.py` | One text file of results per thesis |

## Limits

- Form D covers founders once they raise. Builders before the round come only from GitHub, Show HN and arXiv, so founders who build in private won't appear.
- Founders are the officers named on the filing; some filings list a lawyer or CFO instead.
- About half of screened startups end up without a website, and a guessed site can be the wrong company. The report says which sites were guessed.
- Repeat-founder detection matches names exactly, so a common name can be a different person.
- Through Nicrron, the effort setting isn't passed on, so Claude judges at its default effort.
- Dossiers only cover what the free sources (and optional akta.pro profiles) show. Many Form D founders have little public footprint, so a third of dossiers come out with low confidence.
