# Outreach API

Drafts personal emails for shortlisted founders, lets the investor approve, edit or skip them, and drafts answers to founder replies. Runs on the Nicrron gateway. **Nothing here sends email**: "approved" only marks a draft.

## Run

```bash
cd outreach
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # add NICRRON_API_KEY, or set MOCK_LLM=1
.venv/bin/python app.py       # http://localhost:5001
```

`MOCK_LLM=1` returns canned answers: no network, no cost. Use it while building the frontend.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `{ok, mock, model}` |
| POST | `/drafts` | `{records: [...], investor?: {name, firm}}` (max 25 records; each needs `company` and `why`) | `{drafts: [{id, lead_id, fund, founder_name, company, subject, body, status, cost_usd, thread}]}` |
| GET | `/drafts` | | every draft so far |
| POST | `/drafts/{id}/approve` | `{body?: "edited text"}` | `{id, status: "approved"}` |
| POST | `/drafts/{id}/skip` | | `{id, status: "skipped"}` |
| POST | `/drafts/{id}/reply` | `{reply_text, availability?: ["slot", ...]}` (draft must be approved) | `{intent, response_body, proposed_times, cost_usd}` |
| GET | `/cost` | | `{total_usd, requests, unpriced}` |

A shortlist record looks like `sample_records.json`. Try it:

```bash
curl -s -X POST localhost:5001/drafts -H 'Content-Type: application/json' -d @sample_records.json
```

`lead_id` comes from the record (empty for hand-written records) and `fund` is set when the draft was made through `/funds/{fund}/drafts`; otherwise both are `null`.

## Lead-funnel results

These routes read the lead funnel's founder results (read only; nothing is written into `lead-funnel/`). They look in `FUNNEL_OUT_DIR`, one folder per fund, default `../lead-funnel/out/founders` relative to `outreach/`. Deployed on its own (e.g. on Render) without `lead-funnel/`, point `FUNNEL_OUT_DIR` at a copy of the results, such as `data/founders` (git-ignored). If the folder, a fund or a file is missing, the route answers 404 with `{"error": ...}`.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/funds` | | `{funds: [{name, has_leads, has_dossiers}]}` |
| GET | `/funds/{fund}/shortlist` | `?min_fit=3&skip=co:1,co:2` | `{fund, min_fit, records: [...], dropped: {low_fit, skipped, unusable}}`; each record is what `from_funnel.py` writes plus `rank` (1 = best) and `score` |
| GET | `/funds/{fund}/dossiers/{lead_id}` | | that founder's dossier from `dossiers.json` |
| POST | `/funds/{fund}/drafts` | `{lead_ids?: [...], investor?: {name, firm}, min_fit?: 3}` | same as `POST /drafts`. Without `lead_ids` it drafts the whole shortlist at `min_fit`; a lead id not on it is a 400 |

Records are built exactly as `from_funnel.py` builds them: the judge's contact as `founder_name`, leads below `min_fit` dropped, only verified quotes, dossier openers as unverified hints, `exclusion_hits` as warnings. `{fund}` must be a folder name from `/funds`.

```bash
curl -s localhost:5001/funds
curl -s 'localhost:5001/funds/example_fund/shortlist?min_fit=2&skip=co:0001962104'
curl -s localhost:5001/funds/example_fund/dossiers/co:0002130106
curl -s -X POST localhost:5001/funds/example_fund/drafts -H 'Content-Type: application/json' \
     -d '{"lead_ids": ["co:0002130106"], "investor": {"name": "Alex Rivera", "firm": "Example Ventures"}}'
```

Errors are `{"error": "..."}`. The status codes are 400 (bad body), 404 (unknown draft, fund, file or dossier), 409 (reply before approve), 402 (Nicrron balance too low) and 502 (model or gateway failed).

## Notes

- Drafts live in memory, so they reset when the server restarts.
- `proposed_times` only ever contains slots from `availability`. A time the model invents is dropped.
- `cost_usd` is the exact charge from Nicrron's `/v1/generation`, fee included. It is `null` if billing hasn't settled yet, and those requests are counted in `/cost` as `unpriced`.
