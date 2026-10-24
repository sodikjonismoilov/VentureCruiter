"""Durable, tenant-scoped VC matching over public SEC filings and firm websites.

The source funnel's useful pieces are adapted to Cypher's worker model: SEC data
is cached once for all workspaces, run criteria and results stay tenant-owned,
and website reads use the existing SSRF-safe, robots-aware profile reader. No
paid enrichment, email access, or outreach is performed here.
"""
import asyncio
import csv
import gzip
import hashlib
import html
import io
import json
import math
import re
import zipfile
from collections import defaultdict
from contextlib import suppress
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
from sqlalchemy import func, or_, select, text

from app.db.tenancy import current_tenant_id
from app.models.investor_funnel import (
    InvestorMatchLabel,
    InvestorMatchRun,
    InvestorUniverseSnapshot,
    FounderArchiveBackfill,
    FounderLead,
    utcnow,
)

FORMD_PAGE = "https://www.sec.gov/data-research/sec-markets-data/form-d-data-sets"
ADV_PAGE = "https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers"
FORMD_URL = "https://www.sec.gov/data-research/sec-markets-data/form-d-data-sets"
ADV_URL = "https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers"
SNAPSHOT_ID = "current"
SNAPSHOT_MAX_AGE_DAYS = 90
FOUNDER_SYNC_LOCK = 1763000413
SEC_FILE_LIMIT = 160 * 1024 * 1024
SEC_PAGE_LIMIT = 3 * 1024 * 1024
GENERIC = set("fund funds ventures venture capital partners partner management managers advisors advisers adviser gp holdings investments investment associates group the growth opportunity opportunities early seed spv coinvest co invest parallel feeder offshore onshore master annex select vc equity global technology technologies of and lab labs".split())
LEGAL = re.compile(r"\b(l\.?l\.?c|l\.?p|l\.?l\.?p|inc|ltd|gmbh|corp|corporation|co|company|incorporated|limited|plc|series\s+\S+)\b\.?", re.I)
SKIP_INDUSTRY = re.compile(r"Real Estate|REIT|Residential|Commercial$|Oil|Gas|Coal|Mining|Restaurants|Lodging|Investing|Pooled|Agriculture", re.I)
VEHICLE = re.compile(r"\b(spv|series|co-?invest|coinvest|opportunit|annex|parallel|feeder|sidecar|select|continuation)\b", re.I)
STOP_WORDS = set("the and for with from that this into your our are you company companies platform product venture fund investors investment software business about their they have has will would should across using based build building".split())
csv.field_size_limit(10**7)


class FunnelError(Exception):
    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(detail)


def sec_user_agent(email: str | None):
    contact = (email or "").strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", contact):
        return ""
    return f"Cypher VC Research ({contact})"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def record_event(run, kind, **detail):
    run.events = [*(run.events or []), {"type": kind, "at": now_iso(), **detail}][-100:]


def _validate_sec_url(url: str):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in {"www.sec.gov", "sec.gov"}
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise FunnelError("invalid_sec_source", "The SEC returned an unsupported data URL.")


async def _read_sec(client: httpx.AsyncClient, url: str, user_agent: str, limit: int) -> bytes:
    _validate_sec_url(url)
    chunks = bytearray()
    total_size = None
    last_error = None
    try:
        # Archives are a few MB; allow slow transfers and resume partial files
        # with SEC's byte-range support instead of restarting from zero.
        async with asyncio.timeout(600):
            for attempt in range(5):
                headers = {
                    "User-Agent": user_agent,
                    "Accept": "text/html,application/zip,*/*",
                    "Accept-Encoding": "identity",
                }
                if chunks:
                    headers["Range"] = f"bytes={len(chunks)}-"
                try:
                    async with client.stream("GET", url, headers=headers) as response:
                        if 300 <= response.status_code < 400:
                            raise FunnelError("sec_redirect_blocked", "The SEC redirected a data request; the redirect was not followed.")
                        if response.status_code == 403:
                            raise FunnelError("sec_rate_limited", "The SEC declined this request. Retry later or contact support if it continues.")
                        if response.status_code == 429:
                            raise FunnelError("sec_rate_limited", "The SEC rate limited this request. Retry the research run later.")
                        if response.status_code not in (200, 206):
                            raise FunnelError("sec_unavailable", f"The SEC data source returned HTTP {response.status_code}.")
                        if response.status_code == 206:
                            content_range = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("content-range", ""))
                            if not content_range or int(content_range.group(1)) != len(chunks):
                                raise FunnelError("sec_range_invalid", "The SEC returned an invalid byte-range response.")
                            total_size = int(content_range.group(3))
                        else:
                            chunks.clear()
                            declared = response.headers.get("content-length", "")
                            total_size = int(declared) if declared.isdigit() else None
                        if total_size is not None and total_size > limit:
                            raise FunnelError("sec_file_too_large", "An SEC source file exceeded the configured download limit.")
                        async for part in response.aiter_bytes():
                            chunks.extend(part)
                            if len(chunks) > limit:
                                raise FunnelError("sec_file_too_large", "An SEC source file exceeded the configured download limit.")
                        if total_size is not None and len(chunks) != total_size:
                            raise httpx.RemoteProtocolError("SEC response ended before the declared file size.")
                        return bytes(chunks)
                except FunnelError:
                    raise
                except httpx.HTTPError as error:
                    last_error = error
                    if attempt == 4:
                        break
                    await asyncio.sleep(min(2 ** attempt, 8))
    except FunnelError:
        raise
    except TimeoutError:
        raise FunnelError("sec_timeout", "An SEC data request timed out. Retry the research run.") from None
    if isinstance(last_error, httpx.TimeoutException):
        raise FunnelError("sec_timeout", "An SEC data request timed out. Retry the research run.") from None
    raise FunnelError("sec_unavailable", "The SEC data source could not be reached or resumed.") from None


def _links(page: bytes):
    source = page.decode("utf-8", "replace")
    return [html.unescape(value) for value in re.findall(r"href\s*=\s*[\"']([^\"']+)[\"']", source, re.I)]


def _file_date(digits: str):
    year = int(digits[4:]) + (2000 if len(digits) == 6 else 0)
    return year, int(digits[:2]), int(digits[2:4])


def _formd_archives(page: bytes):
    archives = {}
    for link in _links(page):
        # Older SEC archives may have a numeric suffix (for example
        # 2013q1_d_0.zip). Normalize those names to the canonical quarter so
        # each filing quarter is imported exactly once.
        if not re.search(r"_d(?:_\d+)?\.zip(?:$|\?)", link, re.I):
            continue
        url = urljoin(FORMD_PAGE, link)
        _validate_sec_url(url)
        file_name = Path(urlsplit(url).path).name
        match = re.search(r"(\d{4})q([1-4])_d(?:_(\d+))?\.zip$", file_name, re.I)
        if match:
            name = f"{match.group(1)}q{match.group(2)}_d.zip"
            existing = archives.get(name)
            # Prefer the canonical unsuffixed file when the SEC page lists
            # both forms for one quarter.
            if existing is None or match.group(3) is None:
                archives[name] = {"name": name, "url": url, "year": int(match.group(1)), "quarter": int(match.group(2))}
    return sorted(archives.values(), key=lambda item: (item["year"], item["quarter"]), reverse=True)


async def _download_sec_files(contact_email: str):
    user_agent = sec_user_agent(contact_email)
    if not user_agent:
        raise FunnelError("sec_user_agent_required", "Sign in with a verified email address before refreshing the public SEC dataset.")
    timeout = httpx.Timeout(connect=15, read=45, write=30, pool=30)
    limits = httpx.Limits(max_connections=4, max_keepalive_connections=2)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, limits=limits) as client:
        formd_page, adv_page = await asyncio.gather(
            _read_sec(client, FORMD_PAGE, user_agent, SEC_PAGE_LIMIT),
            _read_sec(client, ADV_PAGE, user_agent, SEC_PAGE_LIMIT),
        )
        formd_archives = _formd_archives(formd_page)
        if len(formd_archives) < 4:
            raise FunnelError("sec_formd_files_missing", "The SEC page did not list enough recent Form D data files.")
        adv = []
        for link in _links(adv_page):
            match = re.search(r"/ia(\d{6,8})[^/\"']*\.zip(?:$|\?)", link, re.I)
            if match:
                url = urljoin(ADV_PAGE, link)
                _validate_sec_url(url)
                adv.append((url, match.group(1), "exempt" in url.rsplit("/", 1)[-1].lower()))
        exempt_files = [item for item in adv if item[2]]
        registered_files = [item for item in adv if not item[2]]
        if not exempt_files or not registered_files:
            raise FunnelError("sec_adv_files_missing", "The SEC page did not list the registered and exempt Form ADV data files.")
        recent_archives = formd_archives[:8]
        selected = [item["url"] for item in recent_archives] + [max(exempt_files, key=lambda item: _file_date(item[1]))[0], max(registered_files, key=lambda item: _file_date(item[1]))[0]]
        blobs = {}
        sem = asyncio.Semaphore(3)

        async def download(url):
            async with sem:
                blobs[url] = await _read_sec(client, url, user_agent, SEC_FILE_LIMIT)

        await asyncio.gather(*(download(url) for url in selected))
        return blobs, [item["name"] for item in recent_archives]


async def _list_formd_archives(contact_email: str):
    user_agent = sec_user_agent(contact_email)
    if not user_agent:
        raise FunnelError("sec_user_agent_required", "Sign in with a verified email address before refreshing the public SEC dataset.")
    timeout = httpx.Timeout(connect=15, read=45, write=30, pool=30)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        page = await _read_sec(client, FORMD_PAGE, user_agent, SEC_PAGE_LIMIT)
    archives = _formd_archives(page)
    if len(archives) < 4:
        raise FunnelError("sec_formd_files_missing", "The SEC page did not list enough quarterly Form D data files.")
    return archives


async def _download_formd_archive(contact_email: str, url: str):
    user_agent = sec_user_agent(contact_email)
    if not user_agent:
        raise FunnelError("sec_user_agent_required", "Sign in with a verified email address before refreshing the public SEC dataset.")
    _validate_sec_url(url)
    timeout = httpx.Timeout(connect=15, read=45, write=30, pool=30)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        return await _read_sec(client, url, user_agent, SEC_FILE_LIMIT)


def _tsv(zf, suffix):
    name = next((name for name in zf.namelist() if name.upper().endswith(suffix)), None)
    if not name:
        raise FunnelError("sec_file_invalid", "An SEC Form D archive is missing a required table.")
    return csv.DictReader(io.TextIOWrapper(zf.open(name), encoding="latin-1"), delimiter="\t")


def _money(value):
    try:
        number = float(str(value).replace(",", "").strip())
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _brand(name):
    value = re.sub(r"\(.*?\)", " ", (name or "").lower())
    value = LEGAL.sub(" ", value)
    value = re.sub(r"[^a-z0-9& ]", " ", value)
    return [word for word in value.split() if word not in GENERIC and not re.fullmatch(r"i{1,3}|iv|v|vi{0,3}|ix|x|\d+", word) and len(word) > 1][:2]


def _person_key(first, last):
    norm = lambda value: re.sub(r"[^a-z]", "", (value or "").lower())
    return f"{norm(first)}|{norm(last)}"


def _filing_date(value):
    try:
        return datetime.strptime(value.strip(), "%d-%b-%Y").date().isoformat()
    except (TypeError, ValueError):
        return ""


def _load_adv(blob: bytes):
    firms = []
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        name = next((name for name in zf.namelist() if name.lower().endswith(".csv")), None)
        if not name:
            raise FunnelError("sec_file_invalid", "An SEC Form ADV archive is missing its CSV table.")
        reader = csv.DictReader(io.TextIOWrapper(zf.open(name), encoding="latin-1"))
        for row in reader:
            if not (row.get("Any VC Funds") or "").strip().upper().startswith("Y"):
                continue
            n_vc = int(_money(row.get("Total number of VC funds")) or 0)
            n_all = int(_money(row.get("Count of Private Funds - 7B(1)")) or 0) or n_vc
            if n_vc / max(n_all, 1) < .5:
                continue
            website = (row.get("Website Address") or "").strip()
            if re.search(r"linkedin|twitter|x\.com|facebook|instagram", website, re.I):
                website = ""
            firms.append({
                "id": "crd:" + (row.get("Organization CRD#") or "").strip(),
                "name": (row.get("Primary Business Name") or "").strip().title(),
                "city": (row.get("Main Office City") or "").strip().title(),
                "state": (row.get("Main Office State") or "").strip().upper(),
                "website": website.lower() if website else "",
                "aum": _money(row.get("Total Gross Assets of Private Funds")),
                "n_vc_funds": n_vc,
                "source": "Form ADV",
            })
    return firms


def _build_universe(blobs: dict[str, bytes], quarters: list[str]):
    adv_blobs = [blob for url, blob in blobs.items() if Path(urlsplit(url).path).name.lower().startswith("ia")]
    if len(adv_blobs) != 2:
        raise FunnelError("sec_adv_files_missing", "Could not identify both SEC Form ADV archives.")
    firms = {firm["id"]: firm for blob in adv_blobs for firm in _load_adv(blob)}
    by_token = defaultdict(list)
    for firm in firms.values():
        brand = _brand(firm["name"])
        if brand:
            by_token[brand[0]].append(firm)

    funds, companies = [], []
    formd = [(url, blob) for url, blob in blobs.items() if Path(urlsplit(url).path).name in quarters]
    for source_url, blob in formd:
        source_quarter = Path(urlsplit(source_url).path).name
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            dates = {row["ACCESSIONNUMBER"]: _filing_date(row["FILING_DATE"]) for row in _tsv(zf, "FORMDSUBMISSION.TSV")}
            issuers = {row["ACCESSIONNUMBER"]: row for row in _tsv(zf, "ISSUERS.TSV") if row.get("IS_PRIMARYISSUER_FLAG", "").upper() == "YES"}
            people = defaultdict(list)
            for row in _tsv(zf, "RELATEDPERSONS.TSV"):
                first, last = row.get("FIRSTNAME", "").strip(), row.get("LASTNAME", "").strip()
                if first.upper() in ("", "N/A", "NA", "NONE"):
                    continue
                people[row["ACCESSIONNUMBER"]].append({
                    "first": first.title(), "last": last.title(),
                    "roles": [value for value in (row.get("RELATIONSHIP_1"), row.get("RELATIONSHIP_2"), row.get("RELATIONSHIP_3")) if value],
                    "title": row.get("RELATIONSHIPCLARIFICATION", "").strip()[:120],
                    "state": row.get("STATEORCOUNTRY", "").strip(),
                })
            for row in _tsv(zf, "OFFERING.TSV"):
                accession = row.get("ACCESSIONNUMBER", "")
                issuer = issuers.get(accession)
                if not issuer:
                    continue
                industry = row.get("INDUSTRYGROUPTYPE", "")
                record = {
                    "acc": accession, "name": issuer.get("ENTITYNAME", "").strip(),
                    "cik": issuer.get("CIK", "").strip(), "date": dates.get(accession, ""),
                    "state": issuer.get("STATEORCOUNTRY", "").strip().upper(),
                    "city": issuer.get("CITY", "").strip().title(),
                    "amount": _money(row.get("TOTALOFFERINGAMOUNT")),
                    "sold": _money(row.get("TOTALAMOUNTSOLD")), "industry": industry,
                    "people": people.get(accession, []), "quarter": source_quarter,
                }
                if row.get("INVESTMENTFUNDTYPE") == "Venture Capital Fund":
                    funds.append(record)
                elif not row.get("INVESTMENTFUNDTYPE") and row.get("ISPOOLEDINVESTMENTFUNDTYPE", "").lower() != "true" and not SKIP_INDUSTRY.search(industry):
                    companies.append(record)

    for filing in funds:
        brand = _brand(filing["name"])
        if not brand:
            continue
        matches = by_token.get(brand[0], [])
        if len(matches) > 1:
            matches = [firm for firm in matches if _brand(firm["name"])[:2] == brand[:2]] or [firm for firm in matches if firm["state"] == filing["state"]]
        if len(matches) == 1:
            firm = matches[0]
        else:
            firm_id = "fd:" + " ".join(brand)
            firm = firms.setdefault(firm_id, {"id": firm_id, "name": filing["name"].split(",")[0].strip(), "city": filing["city"], "state": filing["state"], "website": "", "aum": None, "n_vc_funds": 0, "source": "Form D"})
        firm.setdefault("funds", []).append({key: filing[key] for key in ("name", "date", "amount", "sold", "acc", "cik")})
        for person in filing["people"]:
            key = _person_key(person["first"], person["last"])
            firm.setdefault("people", {}).setdefault(key, {"name": f"{person['first']} {person['last']}", "title": person["title"], "funds": 0})["funds"] += 1

    owners = defaultdict(set)
    for firm in firms.values():
        for key in firm.get("people", {}):
            owners[key].add(firm["id"])
    for company in companies:
        for person in company["people"]:
            if "Director" not in person["roles"] or "Executive Officer" in person["roles"]:
                continue
            ids = owners.get(_person_key(person["first"], person["last"]), set())
            if len(ids) == 1:
                firm = firms[next(iter(ids))]
                firm.setdefault("board_seats", []).append({"company": company["name"], "industry": company["industry"], "amount": company["amount"], "date": company["date"], "state": company["state"], "person": f"{person['first']} {person['last']}"})
    for firm in firms.values():
        firm.setdefault("funds", []).sort(key=lambda item: item["date"], reverse=True)
        firm.setdefault("people", {})
        seats = sorted(firm.setdefault("board_seats", []), key=lambda item: item["date"])
        firm["board_seats"] = list({(seat["company"], seat["person"]): seat for seat in seats}.values())
    return {"built": now_iso(), "quarters": quarters, "firms": list(firms.values()), "companies": companies}


def _normalized_key(value):
    return " ".join(re.findall(r"[^\W_]+", (value or "").casefold(), re.UNICODE))


def _is_explicit_founder(title, roles):
    return bool(re.search(r"\b(?:co[\s-]?)?founders?\b", " ".join([title or "", *(roles or [])]), re.I))


def _founder_lead_rows(companies):
    """Collapse the rolling SEC window into one evidence row per person and issuer."""
    rows = {}
    for company in companies:
        company_name = (company.get("name") or "").strip()
        normalized_company = _normalized_key(company_name)
        accession = (company.get("acc") or "").strip()
        if not normalized_company or not accession:
            continue
        cik = re.sub(r"\D", "", company.get("cik") or "").lstrip("0")
        company_identity = f"cik:{cik}" if cik else f"name:{normalized_company}|state:{_normalized_key(company.get('state'))}"
        company_key = hashlib.sha256(company_identity.encode("utf-8")).hexdigest()
        source_url = FORMD_URL
        if cik:
            source_url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{accession}-index.html"
        else:
            source_url = f"https://www.sec.gov/edgar/search/#/q={accession}"
        filing_date = None
        try:
            filing_date = date.fromisoformat(company.get("date") or "")
        except ValueError:
            pass
        source_quarter = company.get("quarter") or (
            f"{filing_date.year}q{(filing_date.month - 1) // 3 + 1}_d.zip" if filing_date else None
        )
        for person in company.get("people", []):
            full_name = " ".join(part for part in (person.get("first", "").strip(), person.get("last", "").strip()) if part)
            normalized_person = _normalized_key(full_name)
            if len(normalized_person.split()) < 2:
                continue
            person_key = hashlib.sha256(normalized_person.encode("utf-8")).hexdigest()
            row_id = hashlib.sha256(f"{company_key}:{person_key}".encode("utf-8")).hexdigest()
            roles = list(dict.fromkeys(str(value).strip() for value in (person.get("roles") or []) if str(value).strip()))
            title = str(person.get("title") or "").strip()[:240]
            founder_signal = _is_explicit_founder(title, roles)
            source_quarters = [source_quarter] if source_quarter else []
            founder_evidence = "; ".join(value for value in [title, *roles] if value)[:500] if founder_signal else ""
            row = {
                "id": row_id,
                "person_name": full_name[:240],
                "company_name": company_name[:600],
                "company_key": company_key,
                "person_key": person_key,
                "cik": cik or None,
                "accession": accession,
                "filing_date": filing_date,
                "industry": (company.get("industry") or "")[:160] or None,
                "city": (company.get("city") or "")[:120] or None,
                "state": (person.get("state") or company.get("state") or "")[:80].upper() or None,
                "roles": roles,
                "title": title,
                "founder_signal": founder_signal,
                "founder_evidence": founder_evidence,
                "founder_evidence_date": filing_date if founder_signal else None,
                "founder_evidence_url": source_url if founder_signal else None,
                "offering_amount_usd": company.get("amount"),
                "amount_sold_usd": company.get("sold"),
                "filing_count": 1,
                "source_quarters": source_quarters,
                "source_url": source_url,
                "refreshed_at": utcnow(),
            }
            existing = rows.get(row_id)
            if existing is None:
                rows[row_id] = row
                continue
            existing["filing_count"] += 1
            existing["roles"] = list(dict.fromkeys([*existing["roles"], *roles]))
            existing["founder_signal"] = existing["founder_signal"] or founder_signal
            if founder_signal and (
                not existing["founder_evidence"]
                or (filing_date and (existing["founder_evidence_date"] is None or filing_date > existing["founder_evidence_date"]))
            ):
                existing["founder_evidence"] = founder_evidence
                existing["founder_evidence_date"] = filing_date
                existing["founder_evidence_url"] = source_url
            existing["source_quarters"] = sorted(set([*existing["source_quarters"], *source_quarters]), reverse=True)
            if filing_date and (existing["filing_date"] is None or filing_date > existing["filing_date"]):
                for key in ("person_name", "company_name", "cik", "accession", "filing_date", "industry", "city", "state", "title", "offering_amount_usd", "amount_sold_usd", "source_url"):
                    existing[key] = row[key]
    return list(rows.values())


def _founder_rows_for_archive(blob: bytes, quarter_name: str):
    """Parse one Form D quarter into deduplicated person–issuer evidence rows."""
    companies = []
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        dates = {row["ACCESSIONNUMBER"]: _filing_date(row["FILING_DATE"]) for row in _tsv(zf, "FORMDSUBMISSION.TSV")}
        issuers = {row["ACCESSIONNUMBER"]: row for row in _tsv(zf, "ISSUERS.TSV") if row.get("IS_PRIMARYISSUER_FLAG", "").upper() == "YES"}
        people = defaultdict(list)
        for row in _tsv(zf, "RELATEDPERSONS.TSV"):
            first, last = row.get("FIRSTNAME", "").strip(), row.get("LASTNAME", "").strip()
            if first.upper() in ("", "N/A", "NA", "NONE"):
                continue
            people[row["ACCESSIONNUMBER"]].append({
                "first": first.title(), "last": last.title(),
                "roles": [value for value in (row.get("RELATIONSHIP_1"), row.get("RELATIONSHIP_2"), row.get("RELATIONSHIP_3")) if value],
                "title": row.get("RELATIONSHIPCLARIFICATION", "").strip()[:120],
                "state": row.get("STATEORCOUNTRY", "").strip(),
            })
        for row in _tsv(zf, "OFFERING.TSV"):
            accession = row.get("ACCESSIONNUMBER", "")
            issuer = issuers.get(accession)
            if not issuer:
                continue
            industry = row.get("INDUSTRYGROUPTYPE", "")
            if (row.get("INVESTMENTFUNDTYPE")
                    or row.get("ISPOOLEDINVESTMENTFUNDTYPE", "").lower() == "true"
                    or SKIP_INDUSTRY.search(industry)):
                continue
            companies.append({
                "acc": accession, "name": issuer.get("ENTITYNAME", "").strip(),
                "cik": issuer.get("CIK", "").strip(), "date": dates.get(accession, ""),
                "state": issuer.get("STATEORCOUNTRY", "").strip().upper(),
                "city": issuer.get("CITY", "").strip().title(),
                "amount": _money(row.get("TOTALOFFERINGAMOUNT")),
                "sold": _money(row.get("TOTALAMOUNTSOLD")), "industry": industry,
                "people": people.get(accession, []), "quarter": quarter_name,
            })
    return _founder_lead_rows(companies)


def founder_archive_state(job):
    if job is None:
        return {"status": "idle", "total_quarters": 0, "processed_quarters": 0, "current_quarter": None, "error": None}
    quarter_files = job.quarter_files or []
    cursor = min(job.cursor or 0, len(quarter_files))
    current = quarter_files[cursor]["name"] if cursor < len(quarter_files) and job.status in {"pending", "running", "failed"} else None
    return {
        "status": job.status,
        "total_quarters": len(quarter_files),
        "processed_quarters": cursor,
        "current_quarter": current,
        "error": job.error,
        "started_at": job.started_at.isoformat() + "Z" if job.started_at else None,
        "completed_at": job.completed_at.isoformat() + "Z" if job.completed_at else None,
    }


async def build_universe(contact_email: str):
    blobs, quarters = await _download_sec_files(contact_email)
    try:
        data = await asyncio.to_thread(_build_universe, blobs, quarters)
    except FunnelError:
        raise
    except (KeyError, StopIteration, ValueError, OverflowError, zipfile.BadZipFile, csv.Error, UnicodeError):
        raise FunnelError("sec_data_invalid", "The SEC public data files could not be parsed. Retry after the next SEC refresh.") from None
    packed = await asyncio.to_thread(
        lambda: gzip.compress(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), compresslevel=6)
    )
    founder_leads = await asyncio.to_thread(_founder_lead_rows, data["companies"])
    return packed, len(data["firms"]), quarters, founder_leads


def _terms(value):
    return set(re.findall(r"[a-z0-9]{3,}", (value or "").lower())) - STOP_WORDS


def _mentions(text, phrase):
    return bool(phrase and re.search(r"\b" + re.escape(phrase.strip()) + r"\b", text or "", re.I))


def _fund_size(firm):
    recent = [item["amount"] for item in firm["funds"][:12] if item.get("amount") and item["amount"] >= 5_000_000 and not VEHICLE.search(item.get("name", ""))]
    per_fund = firm.get("aum") / max(1, firm.get("n_vc_funds", 1)) if firm.get("aum") else None
    return max(max(recent), per_fund or 0) if recent else per_fund


def _size_fit(value, low, high):
    if value is None:
        return .5
    if low <= value <= high:
        return 1.0
    gap = math.log(low / value) if value < low else math.log(value / high)
    return max(0.0, min(1.0, math.exp(-gap)))


def _date_recency(firm):
    if not firm.get("funds") or not firm["funds"][0].get("date"):
        return .4
    try:
        months = (date.today() - date.fromisoformat(firm["funds"][0]["date"])).days / 30.4
    except ValueError:
        return .4
    return 1.0 if months <= 12 else .7 if months <= 24 else .4


def _board_fit(firm, thesis):
    seats = firm.get("board_seats", [])
    if not seats:
        return 0.0
    industries = set(thesis.get("industries", []))
    keywords = thesis.get("keywords", [])
    hits = 0
    for seat in seats:
        text = (seat.get("company", "") + " " + seat.get("industry", "")).lower()
        if seat.get("industry") in industries or any(_mentions(text, word) for word in keywords):
            hits += 1
    return min(1.0, hits / max(3, len(seats))) * min(1.0, len(seats) / 3 + .34)


def _hard_filter(firm, thesis):
    if thesis.get("geo_required") and firm.get("state") not in thesis["geo_required"]:
        return False
    if not (firm.get("people") or firm.get("website")):
        return False
    cutoff = thesis.get("max_months_since_fund", 36)
    latest = next((item.get("date") for item in firm.get("funds", []) if item.get("date")), "")
    if latest:
        try:
            if (date.today() - date.fromisoformat(latest)).days / 30.4 > cutoff:
                return False
        except ValueError:
            pass
    size = _fund_size(firm)
    low, high = thesis.get("fund_size_usd", [15_000_000, 500_000_000])
    return size is None or low / 4 <= size <= high * 4


def _base_score(firm, thesis):
    low, high = thesis.get("fund_size_usd", [15_000_000, 500_000_000])
    fund_size = _fund_size(firm)
    seats = len(firm.get("board_seats", []))
    geo = 1.0 if not thesis.get("geo_preferred") or firm.get("state") in thesis["geo_preferred"] else .4
    board_fit = _board_fit(firm, thesis)
    facts = " ".join([firm.get("name", ""), *(item.get("name", "") for item in firm.get("funds", [])[:5]), *(seat.get("company", "") for seat in firm.get("board_seats", []))])
    query = " ".join([thesis.get("one_liner", ""), thesis.get("thesis", ""), *thesis.get("beliefs", []), *thesis.get("keywords", [])])
    a, b = _terms(facts), _terms(query)
    text_fit = min(1.0, len(a & b) / max(4, min(12, len(b)))) if b else 0.0
    features = {
        "size_fit": _size_fit(fund_size, low, high),
        "recency": _date_recency(firm),
        "geo": geo,
        "seats": min(1.0, math.log1p(seats) / math.log(11)),
        "text_fit": text_fit,
        "board_fit": board_fit,
    }
    return {**firm, "features": features, "fund_size": fund_size, "score": _score(features, thesis=thesis)[0]}


def _score(features, website_text="", thesis=None, label=0):
    thesis = thesis or {}
    query_terms = _terms(" ".join([thesis.get("one_liner", ""), thesis.get("thesis", ""), *thesis.get("beliefs", []), *thesis.get("keywords", [])]))
    site_terms = _terms(website_text)
    site_fit = min(1.0, len(site_terms & query_terms) / max(4, min(12, len(query_terms)))) if site_terms and query_terms else 0.0
    text_fit = max(features.get("text_fit", 0), site_fit)
    weights = {"size_fit": .20, "recency": .12, "geo": .07, "seats": .06, "text_fit": .28, "board_fit": .27}
    # Per-workspace feedback gives a small tie-breaker to firms the user has rated.
    value = sum(features.get(key, 0) * weight for key, weight in weights.items() if key != "text_fit") + text_fit * weights["text_fit"]
    value = max(0.0, min(1.0, value + (.05 if label > 0 else -.05 if label < 0 else 0)))
    return round(value * 100, 1), text_fit


def _penalties(firm, thesis, site_text):
    context = " ".join([firm.get("name", ""), *(item.get("name", "") for item in firm.get("funds", [])[:5]), *(seat.get("company", "") for seat in firm.get("board_seats", [])), site_text]).lower()
    exclusions = [word for word in thesis.get("exclusions", []) if _mentions(context, word)]
    competitor_names = " ".join(seat.get("company", "") for seat in firm.get("board_seats", [])).lower()
    conflicts = [word for word in thesis.get("competitors", []) if _mentions(competitor_names, word)]
    hard_set = {word.lower() for word in conflicts}
    soft = [word for word in thesis.get("competitors", []) if _mentions(site_text, word) and word.lower() not in hard_set]
    keyword_hits = sum(1 for word in thesis.get("keywords", []) if _mentions(context, word))
    excluded_by = ", ".join(exclusions) if len(exclusions) >= 3 and len(exclusions) > 2 * keyword_hits else ""
    return excluded_by, conflicts, soft


def _partner(firm, thesis):
    relevant = set(thesis.get("industries", []))
    tally = defaultdict(int)
    for seat in firm.get("board_seats", []):
        tally[seat.get("person", "")] += 2 if seat.get("industry") in relevant else 1
    if tally:
        name = max(tally, key=tally.get)
        match = next((person for person in firm.get("people", {}).values() if person.get("name") == name), {})
        return {"name": name, "title": match.get("title") or "Board member at a portfolio company", "evidence": "Matched from SEC Form D director and related-person records."}
    if firm.get("people"):
        person = max(firm["people"].values(), key=lambda item: item.get("funds", 0))
        return {"name": person.get("name", ""), "title": person.get("title", ""), "evidence": "Named in SEC Form D related-person records."}
    return None


def _preselect(universe, thesis, candidate_limit, labels):
    firms = []
    for firm in universe.get("firms", []):
        if not firm.get("name") or not _hard_filter(firm, thesis):
            continue
        label = labels.get(firm["id"], 0)
        firms.append(_base_score(firm, thesis) | {"label": label})
    firms.sort(key=lambda item: (-item["score"], item["name"].lower()))
    return firms[:candidate_limit]


def _company_score(company, thesis):
    facts = " ".join((company.get("name", ""), company.get("industry", ""), company.get("city", ""), company.get("state", "")))
    query = " ".join([thesis.get("one_liner", ""), thesis.get("thesis", ""), *thesis.get("beliefs", []), *thesis.get("keywords", []), *thesis.get("industries", [])])
    fact_terms, query_terms = _terms(facts), _terms(query)
    overlap = len(fact_terms & query_terms)
    text_fit = min(1.0, overlap / max(3, min(10, len(query_terms)))) if query_terms else 0.0
    industry_terms = _terms(company.get("industry", ""))
    preferred_terms = _terms(" ".join(thesis.get("industries", [])))
    industry_fit = min(1.0, len(industry_terms & preferred_terms) / max(1, len(preferred_terms))) if preferred_terms else text_fit
    preferred_geo = {value.upper() for value in thesis.get("geo_preferred", [])}
    geo = 1.0 if not preferred_geo or company.get("state", "").upper() in preferred_geo else .4
    amount = company.get("amount")
    target = thesis.get("raise_usd")
    amount_fit = _size_fit(amount, max(1, target // 2), max(1, target * 2)) if amount and target else .5
    filing_date = company.get("date")
    recency = .3
    if filing_date:
        try:
            months = (date.today() - date.fromisoformat(filing_date)).days / 30.4
            recency = 1.0 if months <= 6 else .75 if months <= 12 else .45 if months <= 24 else .2
        except ValueError:
            pass
    score = round((text_fit * .55 + industry_fit * .2 + geo * .1 + amount_fit * .05 + recency * .1) * 100, 1)
    return score, {"text_fit": round(text_fit, 3), "industry_fit": round(industry_fit, 3), "geography_fit": round(geo, 3), "raise_fit": round(amount_fit, 3), "filing_recency": round(recency, 3)}


def _preselect_companies(universe, thesis, candidate_limit):
    best = {}
    excluded = [value.lower() for value in thesis.get("exclusions", [])]
    required_geo = {value.upper() for value in thesis.get("geo_required", [])}
    for company in universe.get("companies", []):
        if not company.get("name"):
            continue
        context = f"{company.get('name', '')} {company.get('industry', '')}".lower()
        if any(_mentions(context, word) for word in excluded):
            continue
        if required_geo and company.get("state", "").upper() not in required_geo:
            continue
        amount = company.get("amount")
        target = thesis.get("raise_usd")
        if amount and target and amount > max(target * 5, 10_000_000_000):
            continue
        score, features = _company_score(company, thesis)
        key = re.sub(r"[^a-z0-9]", "", company.get("name", "").lower()) + ":" + company.get("state", "").upper()
        candidate = {**company, "features": features, "score": score}
        if key not in best or (company.get("date", "") or "") > (best[key].get("date", "") or ""):
            best[key] = candidate
    return sorted(best.values(), key=lambda item: (-item["score"], -(item.get("date") and int(item["date"].replace("-", "")) or 0), item["name"].lower()))[:candidate_limit]


def _company_result(item, thesis):
    query_terms = _terms(" ".join([thesis.get("one_liner", ""), thesis.get("thesis", ""), *thesis.get("beliefs", []), *thesis.get("keywords", []), *thesis.get("industries", [])]))
    fact_text = " ".join([item.get("name", ""), item.get("industry", ""), item.get("city", ""), item.get("state", "")])
    matched_terms = sorted(query_terms & _terms(fact_text))[:12]
    filing = None
    if item.get("cik") and item.get("acc"):
        accession_path = item["acc"].replace("-", "")
        cik = re.sub(r"\D", "", item["cik"]).lstrip("0")
        if cik:
            filing = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession_path}/{item['acc']}-index.html"
    person_rows = item.get("people", [])[:12]
    reasons = [f"SEC Form D lists the issuer under {item.get('industry') or 'an unspecified industry'}."]
    if item.get("date"):
        reasons.append(f"Latest located filing date: {item['date']}.")
    if item.get("amount"):
        reasons.append(f"Filing reports a total offering amount of ${item['amount']:,.0f}; this may describe the offering, not the amount still being raised.")
    if matched_terms:
        reasons.append("Name or filing industry overlaps with thesis terms: " + ", ".join(matched_terms) + ".")
    return {
        "id": "issuer:" + re.sub(r"[^a-zA-Z0-9_-]", "", item.get("acc", "")),
        "name": item["name"], "score": item["score"],
        "location": ", ".join(part for part in (item.get("city"), item.get("state")) if part),
        "industry": item.get("industry") or None, "latest_filing_date": item.get("date") or None,
        "offering_amount_usd": item.get("amount"), "amount_sold_usd": item.get("sold"),
        "people_named_in_filing": [{
            "name": f"{person.get('first','')} {person.get('last','')}".strip(),
            "roles": person.get("roles", []), "title": person.get("title", ""),
            "founder_status": "founder_named_in_filing" if _is_explicit_founder(person.get("title", ""), person.get("roles", [])) else "related_person_only",
        } for person in person_rows],
        "matched_terms": matched_terms, "reasons": reasons,
        "sources": [{"label": "SEC Form D filing", "url": filing or FORMD_URL, "retrieved_at": now_iso()}],
        "features": item.get("features", {}), "review_required": True,
        "limitations": ["A Form D issuer is a self-reported offering record, not a verified active fundraising round.", "SEC data does not provide founder contact details or investment intent."],
    }


async def _profile_candidates(candidates):
    from app.services.prospecting_profile import profile, ProfileError

    semaphore = asyncio.Semaphore(8)

    async def one(item):
        website = (item.get("website") or "").strip()
        if not website:
            item["website_profile"] = None
            return item
        if website.lower().startswith("http://"):
            website = "https://" + website[7:]
        elif not website.lower().startswith("https://"):
            website = "https://" + website.lstrip("/")
        async with semaphore:
            try:
                result = await profile(website)
                item["website_profile"] = {"url": result["url"], "title": result["title"], "description": result["description"], "retrieved_at": result["retrieved_at"]}
            except ProfileError:
                item["website_profile"] = None
        return item

    return await asyncio.gather(*(one(item) for item in candidates))


def _result(item, thesis, labels):
    profile = item.get("website_profile") or {}
    site_text = (profile.get("title", "") + " " + profile.get("description", ""))[:1600]
    score, text_fit = _score(item.get("features", {}), site_text, thesis, labels.get(item["id"], 0))
    excluded, conflicts, soft = _penalties(item, thesis, site_text)
    if excluded:
        score = round(score * .5, 1)
    if conflicts:
        score = round(score * .2, 1)
    elif soft:
        score = round(score * .7, 1)
    keywords = thesis.get("keywords", [])
    evidence_text = " ".join([item.get("name", ""), site_text, *(seat.get("company", "") for seat in item.get("board_seats", []))])
    matched_terms = [word for word in keywords if _mentions(evidence_text, word)][:12]
    reasons = []
    if item.get("fund_size"):
        reasons.append(f"Estimated fund size is ${item['fund_size'] / 1_000_000:.0f}M against your ${thesis['fund_size_usd'][0] / 1_000_000:.0f}M–${thesis['fund_size_usd'][1] / 1_000_000:.0f}M target range.")
    recent = next((fund for fund in item.get("funds", []) if fund.get("date")), None)
    if recent:
        reasons.append(f"Recent SEC Form D filing: {recent['name']} on {recent['date']}.")
    if item.get("board_seats"):
        reasons.append(f"SEC filings show {len(item['board_seats'])} matched portfolio-company board seat(s).")
    if site_text and text_fit > 0:
        reasons.append("Public website language overlaps with your thesis; review the cited excerpt for context.")
    elif site_text:
        reasons.append("The public firm website was reviewed, but it did not clearly repeat your thesis terms.")
    if not reasons:
        reasons.append("Public SEC records identify this firm as a venture adviser; available evidence is limited.")
    funds = [{"name": fund["name"], "date": fund["date"], "amount": fund.get("amount")} for fund in item.get("funds", [])[:6]]
    seats = [{"company": seat["company"], "industry": seat["industry"], "date": seat["date"], "person": seat["person"]} for seat in item.get("board_seats", [])[:20]]
    sources = [
        {"label": "SEC Form ADV public dataset", "url": ADV_URL, "retrieved_at": now_iso()},
        {"label": "SEC Form D public datasets", "url": FORMD_URL, "retrieved_at": now_iso()},
    ]
    if profile.get("url"):
        sources.append({"label": "Firm website", "url": profile["url"], "retrieved_at": profile.get("retrieved_at")})
    return {
        "id": item["id"], "name": item["name"], "score": score,
        "location": ", ".join(part for part in (item.get("city"), item.get("state")) if part),
        "website": item.get("website") or None, "fund_size_usd": item.get("fund_size"),
        "funds": funds, "people": list(item.get("people", {}).values())[:20],
        "recommended_partner": _partner(item, thesis), "board_seats": seats,
        "website_excerpt": site_text, "website_title": profile.get("title", ""),
        "matched_terms": matched_terms, "reasons": reasons,
        "excluded_by": excluded or None, "conflicts": conflicts,
        "possible_conflicts": soft, "sources": sources,
        "features": {**item.get("features", {}), "text_fit": round(text_fit, 3)},
        "review_required": True,
    }


def snapshot(run, cache=None):
    built_at = cache.built_at.isoformat() + "Z" if cache and cache.built_at else None
    return {
        "id": run.id, "direction": run.direction, "thesis": run.thesis, "limit": run.limit,
        "candidate_limit": run.candidate_limit, "status": run.status,
        "phase": run.phase, "candidate_count": len(run.candidates or []), "candidates_done": run.cursor,
        "results": run.results or [], "events": run.events or [],
        "error": run.error, "created_at": run.created_at.isoformat() + "Z" if run.created_at else None,
        "completed_at": run.completed_at.isoformat() + "Z" if run.completed_at else None,
        "source_snapshot": {"firm_count": cache.firm_count, "built_at": built_at} if cache else None,
        "limitations": ([
            "SEC records are incomplete and may lag recent fund activity.",
            "Fund size and relevance scores are estimates from public filings and site text, not verified investment intent.",
            "Partner names and board seats are matched from public filing records and may be incomplete.",
        ] if run.direction == "investors_for_thesis" else [
            "SEC Form D records do not confirm that a company is still fundraising or seeking investment.",
            "The company rankings use filing names, industry, geography, and filing recency; they are a first-pass screen.",
            "Named people are copied from public filing records and may not be founders or current executives.",
        ]) + ["No paid enrichment, personal contact lookup, mailbox access, or message sending is performed; outreach packages are drafts for review."],
    }


def prepare_outreach(run, result):
    """Create a source-grounded, editable outreach and meeting prep packet."""
    firm_to_company = run.direction == "investors_for_thesis"
    thesis = run.thesis or {}
    if firm_to_company:
        recipient = (result.get("recommended_partner") or {}).get("name") or "[Investor name]"
        subject = f"{thesis.get('one_liner', 'Investment opportunity')} — possible fit with {result.get('name', 'your fund')}"
        evidence = next((fund for fund in result.get("funds", []) if fund.get("date")), None)
        signal = (f"I noticed the public SEC filing for {evidence.get('name')} dated {evidence.get('date')}." if evidence else "Your firm's public investment information looks potentially relevant to what we are building.")
        opening = f"I'm reaching out because {thesis.get('one_liner', '[one-line company description]')}"
        ask = "Would you be open to a brief conversation to see whether this fits your current investment focus?"
        prep_questions = ["What stage, check size, and ownership range is the fund targeting now?", "Who leads this area and what is the best way to share a short deck?", "What evidence would be most useful to evaluate the opportunity?"]
        side = "company to investor"
    else:
        people = result.get("people_named_in_filing", [])
        recipient = people[0].get("name") if people else "[Founder or executive name]"
        subject = f"Potential fit with {thesis.get('one_liner', 'our investment focus')}"
        signal = f"I came across the SEC Form D filing dated {result.get('latest_filing_date') or '[filing date]'} for {result.get('name')}."
        opening = f"Our investment focus is {thesis.get('one_liner', '[your fund thesis]')}"
        ask = "Would a short conversation be useful to compare your current priorities with our investment focus?"
        prep_questions = ["Are you currently raising or planning a financing?", "What milestones and capital needs are most important over the next 12 months?", "What kind of investor support would be useful beyond capital?"]
        side = "investor to company"
    body = "\n\n".join([
        f"Hi {recipient},",
        f"{opening}. {signal}",
        "I don't want to assume the timing or fit from public records alone, so I wanted to ask directly.",
        ask,
        "\nBest,\n[Your name]\n[Fund or company]",
    ])
    public_signals = list(result.get("reasons", []))
    return {
        "direction": side,
        "status": "draft_for_review",
        "recipient": recipient,
        "recipient_contact": None,
        "subject": subject,
        "body": body,
        "meeting_brief": {
            "goal": "Confirm mutual relevance, current timing, and the right next step.",
            "public_signals": public_signals,
            "questions": prep_questions,
            "before_sending": ["Verify the recipient and current investment or fundraising focus.", "Replace bracketed details with accurate information.", "Review the cited SEC record and remove any claim you cannot substantiate."],
            "sources": result.get("sources", []),
        },
        "sending": "This is a draft. Cypher does not send messages from this workflow. Review it, supply a verified recipient address, and use an explicitly requested connected email action if available.",
    }


async def _insert_founder_rows(db, rows):
    # SEC refreshes replace the compressed recent snapshot, but the searchable
    # people table can also contain historical quarters. Keep those rows and
    # upsert the latest evidence instead of truncating the full archive.
    for start in range(0, len(rows), 500):
        batch = rows[start:start + 500]
        existing_rows = (await db.execute(
            select(FounderLead).where(FounderLead.id.in_([row["id"] for row in batch]))
        )).scalars().all()
        existing_by_id = {row.id: row for row in existing_rows}
        for values in batch:
            current = existing_by_id.get(values["id"])
            if current is None:
                db.add(FounderLead(**values))
                continue
            current.roles = list(dict.fromkeys([*(current.roles or []), *(values.get("roles") or [])]))
            current.source_quarters = sorted(set([*(current.source_quarters or []), *(values.get("source_quarters") or [])]), reverse=True)
            current.filing_count = max(current.filing_count or 0, values.get("filing_count") or 1)
            if values.get("founder_signal"):
                current.founder_signal = True
                evidence_date = values.get("founder_evidence_date")
                if (not current.founder_evidence
                        or (evidence_date and (current.founder_evidence_date is None or evidence_date > current.founder_evidence_date))):
                    current.founder_evidence = values.get("founder_evidence") or ""
                    current.founder_evidence_date = evidence_date
                    current.founder_evidence_url = values.get("founder_evidence_url")
            filing_date = values.get("filing_date")
            if filing_date and (current.filing_date is None or filing_date > current.filing_date):
                for key in ("person_name", "company_name", "cik", "accession", "filing_date", "industry", "city", "state", "title", "offering_amount_usd", "amount_sold_usd", "source_url"):
                    setattr(current, key, values[key])
            current.refreshed_at = utcnow()
        await db.flush()


async def _save_universe(sessions, packed, firm_count, quarters, founder_leads):
    async with sessions() as db:
        if db.bind.dialect.name == "postgresql":
            await db.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": FOUNDER_SYNC_LOCK})
        await _insert_founder_rows(db, founder_leads)
        row = await db.get(InvestorUniverseSnapshot, SNAPSHOT_ID)
        if row is None:
            row = InvestorUniverseSnapshot(id=SNAPSHOT_ID, payload=packed, firm_count=firm_count, quarters=quarters, built_at=utcnow())
            db.add(row)
        else:
            row.payload, row.firm_count, row.quarters, row.built_at = packed, firm_count, quarters, utcnow()
        await db.commit()


async def ensure_founder_leads(db):
    """Backfill the searchable table from a pre-existing compressed snapshot once."""
    if db.bind.dialect.name == "postgresql":
        await db.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": FOUNDER_SYNC_LOCK})
    count = await db.scalar(select(func.count()).select_from(FounderLead))
    if count:
        return count
    cache = await db.get(InvestorUniverseSnapshot, SNAPSHOT_ID)
    if cache is None:
        return 0
    try:
        universe = await asyncio.to_thread(lambda: json.loads(gzip.decompress(cache.payload)))
    except (OSError, ValueError, TypeError):
        return 0
    rows = await asyncio.to_thread(_founder_lead_rows, universe.get("companies", []))
    if rows:
        await _insert_founder_rows(db, rows)
        await db.commit()
    return len(rows)


async def enqueue_founder_archive(db, requested_by):
    job = await db.get(FounderArchiveBackfill, "historical")
    if job is None:
        job = FounderArchiveBackfill(id="historical", requested_by=requested_by, status="pending")
        db.add(job)
    elif job.status == "failed":
        job.requested_by = requested_by
        job.status = "pending"
        job.error = None
        job.completed_at = None
    await db.commit()
    await db.refresh(job)
    return founder_archive_state(job)


async def get_founder_archive_state(db):
    return founder_archive_state(await db.get(FounderArchiveBackfill, "historical"))


async def _merge_archive_rows(db, rows, quarter_name):
    for start in range(0, len(rows), 500):
        batch = rows[start:start + 500]
        existing_rows = (await db.execute(
            select(FounderLead).where(FounderLead.id.in_([row["id"] for row in batch]))
        )).scalars().all()
        existing_by_id = {row.id: row for row in existing_rows}
        for values in batch:
            current = existing_by_id.get(values["id"])
            if current is None:
                db.add(FounderLead(**values))
                continue
            source_quarters = list(current.source_quarters or [])
            if quarter_name in source_quarters:
                continue
            current.source_quarters = sorted(set([*source_quarters, quarter_name]), reverse=True)
            current.filing_count = (current.filing_count or 0) + (values.get("filing_count") or 1)
            current.roles = list(dict.fromkeys([*(current.roles or []), *(values.get("roles") or [])]))
            if values.get("founder_signal"):
                current.founder_signal = True
                new_evidence_date = values.get("founder_evidence_date")
                if (not current.founder_evidence
                        or (new_evidence_date and (current.founder_evidence_date is None or new_evidence_date > current.founder_evidence_date))):
                    current.founder_evidence = values.get("founder_evidence") or ""
                    current.founder_evidence_date = new_evidence_date
                    current.founder_evidence_url = values.get("founder_evidence_url")
            filing_date = values.get("filing_date")
            if filing_date and (current.filing_date is None or filing_date > current.filing_date):
                for key in ("person_name", "company_name", "cik", "accession", "filing_date", "industry", "city", "state", "title", "offering_amount_usd", "amount_sold_usd", "source_url"):
                    setattr(current, key, values[key])
            current.refreshed_at = utcnow()
        await db.flush()


async def tick_founder_archive(sessions, pulse=None):
    """Import at most one quarterly Form D archive and persist its checkpoint."""
    async with sessions() as db:
        job = (await db.execute(
            select(FounderArchiveBackfill).where(
                FounderArchiveBackfill.id == "historical",
                FounderArchiveBackfill.status.in_(["pending", "running"]),
            ).with_for_update(skip_locked=True)
        )).scalar_one_or_none()
        if job is None:
            return False
        if job.status == "pending":
            job.status = "running"
            job.started_at = job.started_at or utcnow()
            job.error = None
        requested_by = job.requested_by
        cursor = job.cursor or 0
        quarter_files = list(job.quarter_files or [])
        needs_listing = not quarter_files
        await db.commit()

    try:
        from app.models.user import User
        async with sessions() as db:
            user = await db.get(User, requested_by)
            contact_email = user.email if user else None
            cache = await db.get(InvestorUniverseSnapshot, SNAPSHOT_ID)
            current_quarters = set(cache.quarters or []) if cache else set()
        if not sec_user_agent(contact_email):
            raise FunnelError("sec_contact_email_missing", "A verified sign-in email is required to access the SEC public archive.")

        if needs_listing:
            archives = await _await_with_pulse(_list_formd_archives(contact_email), pulse)
            older_archives = [item for item in archives if item["name"] not in current_quarters]
            async with sessions() as db:
                job = (await db.execute(select(FounderArchiveBackfill).where(
                    FounderArchiveBackfill.id == "historical",
                ).with_for_update())).scalar_one_or_none()
                if job is None:
                    return True
                job.quarter_files = older_archives
                if not older_archives:
                    job.status = "completed"
                    job.completed_at = utcnow()
                await db.commit()
            return True

        if cursor >= len(quarter_files):
            # Re-read the archive page after the first pass. The SEC uses
            # suffixed names for some older quarters, which the original
            # listing omitted.
            archives = await _await_with_pulse(_list_formd_archives(contact_email), pulse)
            async with sessions() as db:
                job = (await db.execute(select(FounderArchiveBackfill).where(
                    FounderArchiveBackfill.id == "historical",
                ).with_for_update())).scalar_one_or_none()
                if job and job.status == "running":
                    cache = await db.get(InvestorUniverseSnapshot, SNAPSHOT_ID)
                    processed = set(cache.quarters or []) if cache else set()
                    processed.update(item["name"] for item in quarter_files[:cursor])
                    queued = {item["name"] for item in quarter_files[cursor:]}
                    gaps = [item for item in archives if item["name"] not in processed and item["name"] not in queued]
                    if gaps:
                        job.quarter_files = [*quarter_files, *gaps]
                        job.completed_at = None
                    else:
                        job.status = "completed"
                        job.completed_at = utcnow()
                    await db.commit()
            return True

        archive = quarter_files[cursor]
        blob = await _await_with_pulse(_download_formd_archive(contact_email, archive["url"]), pulse)
        rows = await _await_with_pulse(asyncio.to_thread(_founder_rows_for_archive, blob, archive["name"]), pulse)
        async with sessions() as db:
            job = (await db.execute(select(FounderArchiveBackfill).where(
                FounderArchiveBackfill.id == "historical",
            ).with_for_update())).scalar_one_or_none()
            if job is None or job.status != "running":
                return True
            await _merge_archive_rows(db, rows, archive["name"])
            job.cursor = cursor + 1
            if job.cursor >= len(job.quarter_files or []):
                job.status = "completed"
                job.completed_at = utcnow()
            await db.commit()
        return True
    except asyncio.CancelledError:
        raise
    except Exception as error:
        detail = error.detail if isinstance(error, FunnelError) else f"Could not import {quarter_files[cursor].get('name', 'the SEC archive') if cursor < len(quarter_files) else 'the SEC archive'}. Resume the historical import to retry."
        async with sessions() as db:
            job = (await db.execute(select(FounderArchiveBackfill).where(
                FounderArchiveBackfill.id == "historical",
            ).with_for_update())).scalar_one_or_none()
            if job and job.status == "running":
                job.status = "failed"
                job.error = detail[:1000]
                job.completed_at = utcnow()
                await db.commit()
        return True


async def search_founder_leads(db, q=None, industry=None, state=None, founder_only=False, limit=25, offset=0):
    await ensure_founder_leads(db)
    filters = []
    query = (q or "").strip()
    if query:
        filters.append(or_(
            FounderLead.person_name.contains(query, autoescape=True),
            FounderLead.company_name.contains(query, autoescape=True),
            FounderLead.title.contains(query, autoescape=True),
        ))
    if industry and industry.strip():
        filters.append(FounderLead.industry.contains(industry.strip(), autoescape=True))
    if state and state.strip():
        filters.append(FounderLead.state.ilike(state.strip()))
    if founder_only:
        filters.append(FounderLead.founder_signal.is_(True))

    matched_count = await db.scalar(select(func.count()).select_from(FounderLead).where(*filters)) or 0
    database_count = await db.scalar(select(func.count()).select_from(FounderLead)) or 0
    explicit_count = await db.scalar(select(func.count()).select_from(FounderLead).where(FounderLead.founder_signal.is_(True))) or 0
    rows = (await db.execute(
        select(FounderLead).where(*filters)
        .order_by(FounderLead.filing_date.desc().nullslast(), FounderLead.company_name, FounderLead.person_name)
        .offset(offset).limit(limit)
    )).scalars().all()
    cache = await db.get(InvestorUniverseSnapshot, SNAPSHOT_ID)
    archive_job = await db.get(FounderArchiveBackfill, "historical")
    history = founder_archive_state(archive_job)
    loaded_quarters = set(cache.quarters or []) if cache else set()
    if archive_job:
        loaded_quarters.update(item["name"] for item in (archive_job.quarter_files or [])[:history["processed_quarters"]])
    def quarter_sort(name):
        match = re.fullmatch(r"(\d{4})q([1-4])_d\.zip", name, re.I)
        return (int(match.group(1)), int(match.group(2))) if match else (0, 0)
    all_quarters = sorted(loaded_quarters, key=quarter_sort, reverse=True)
    return {
        "database": {
            "records": database_count,
            "explicit_founder_signals": explicit_count,
            "matched_records": matched_count,
            "snapshot_ready": cache is not None,
            "snapshot_built_at": cache.built_at.isoformat() + "Z" if cache and cache.built_at else None,
            "quarters": all_quarters[:8],
            "quarter_count": len(all_quarters),
            "historical": history,
            "source": "SEC Form D public data",
        },
        "items": [{
            "id": row.id,
            "person_name": row.person_name,
            "company_name": row.company_name,
            "accession": row.accession,
            "founder_status": "founder_named_in_filing" if row.founder_signal else "related_person_only",
            "roles": row.roles or [],
            "title": row.title,
            "founder_evidence": row.founder_evidence or None,
            "founder_evidence_date": row.founder_evidence_date.isoformat() if row.founder_evidence_date else None,
            "founder_evidence_url": row.founder_evidence_url,
            "filing_date": row.filing_date.isoformat() if row.filing_date else None,
            "industry": row.industry,
            "location": {"city": row.city, "state": row.state},
            "offering_amount_usd": row.offering_amount_usd,
            "amount_sold_usd": row.amount_sold_usd,
            "filing_count_in_snapshot": row.filing_count,
            "source_quarters": row.source_quarters or [],
            "source_url": row.source_url,
        } for row in rows],
        "page": {"limit": limit, "offset": offset, "returned": len(rows)},
        "next_step": None if cache else "Start a company-for-thesis investor match to trigger the signed-in account's live SEC refresh, then search again.",
        "limitations": [
            "A filing names related persons; only rows whose filed title or role explicitly says founder are labeled as founders.",
            "SEC Form D does not verify current employment, current fundraising status, or personal contact details.",
            "The recent SEC snapshot covers eight quarters. Historical SEC Form D archives can be indexed back to January 2008.",
        ],
    }


async def _load_universe(db):
    cache = await db.get(InvestorUniverseSnapshot, SNAPSHOT_ID)
    if not cache:
        return None, None
    try:
        return json.loads(gzip.decompress(cache.payload)), cache
    except (OSError, ValueError, TypeError):
        return None, cache


async def _fail(sessions, run_id, error: FunnelError):
    async with sessions() as db:
        row = (await db.execute(select(InvestorMatchRun).where(InvestorMatchRun.id == run_id).with_for_update())).scalar_one_or_none()
        if not row:
            return
        row.status = "failed"
        row.phase = "failed"
        row.error = error.detail
        row.completed_at = utcnow()
        record_event(row, "source_error", code=error.code, detail=error.detail)
        await db.commit()


async def _get_labels(db, tenant_id):
    rows = (await db.execute(select(InvestorMatchLabel).where(InvestorMatchLabel.tenant_id == tenant_id))).scalars().all()
    return {row.firm_id: row.label for row in rows}


async def _await_with_pulse(awaitable, pulse):
    if pulse is None:
        return await awaitable
    task = asyncio.create_task(awaitable)
    try:
        while not task.done():
            await asyncio.wait({task}, timeout=10)
            if not task.done():
                await pulse()
        return await task
    except BaseException:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        raise


async def tick(sessions, pulse=None):
    """Advance one durable investor-matching job by one bounded phase or batch."""
    async with sessions() as db:
        row = (await db.execute(select(InvestorMatchRun).where(
            InvestorMatchRun.status.in_(["pending", "running", "cancel_requested"]),
        ).order_by(InvestorMatchRun.created_at).limit(1).with_for_update(skip_locked=True))).scalar_one_or_none()
        if row is None:
            return False
        run_id, tenant_id = row.id, row.tenant_id
        tenant = current_tenant_id.set(tenant_id)
        try:
            if row.status == "cancel_requested":
                row.status, row.phase, row.completed_at = "cancelled", "cancelled", utcnow()
                record_event(row, "cancelled")
                await db.commit()
                return True
            if row.status == "pending":
                row.status, row.phase = "running", "universe"
                record_event(row, "started", source="SEC Form ADV and Form D")
                await db.commit()
            phase = row.phase
            thesis = row.thesis
            direction = row.direction
            candidate_limit, result_limit = row.candidate_limit, row.limit
            cursor = row.cursor
            candidates = list(row.candidates or [])
            await db.commit()
        finally:
            current_tenant_id.reset(tenant)

    if phase == "universe":
        async with sessions() as db:
            universe, cache = await _load_universe(db)
            fresh = bool(cache and cache.built_at and (utcnow() - cache.built_at).days < SNAPSHOT_MAX_AGE_DAYS)
        if not fresh:
            try:
                async with sessions() as db:
                    from app.models.user import User
                    user = await db.get(User, tenant_id)
                    contact_email = user.email if user else None
                if not sec_user_agent(contact_email):
                    await _fail(sessions, run_id, FunnelError("sec_contact_email_missing", "A verified sign-in email is required to refresh the SEC public-data snapshot."))
                    return True
                packed, firm_count, quarters, founder_leads = await _await_with_pulse(build_universe(contact_email), pulse)
                await _save_universe(sessions, packed, firm_count, quarters, founder_leads)
            except FunnelError as error:
                await _fail(sessions, run_id, error)
                return True
        async with sessions() as db:
            tenant_token = current_tenant_id.set(tenant_id)
            try:
                row = (await db.execute(select(InvestorMatchRun).where(InvestorMatchRun.id == run_id).with_for_update())).scalar_one_or_none()
                if row and row.status == "cancel_requested":
                    row.status, row.phase, row.completed_at = "cancelled", "cancelled", utcnow()
                    record_event(row, "cancelled")
                elif row:
                    row.phase = "source"
                    record_event(row, "sec_snapshot_ready", firm_count=firm_count if not fresh else cache.firm_count, founder_lead_count=len(founder_leads) if not fresh else None, refreshed=not fresh, source_url=FORMD_URL)
                await db.commit()
            finally:
                current_tenant_id.reset(tenant_token)
        return True

    if phase == "source":
        async with sessions() as db:
            universe, cache = await _load_universe(db)
            labels = await _get_labels(db, tenant_id) if direction == "investors_for_thesis" else {}
        if universe is None:
            await _fail(sessions, run_id, FunnelError("sec_snapshot_missing", "The shared SEC dataset is unavailable. Start a new run to rebuild it."))
            return True
        candidates = (_preselect(universe, thesis, candidate_limit, labels) if direction == "investors_for_thesis"
                      else _preselect_companies(universe, thesis, candidate_limit))
        async with sessions() as db:
            tenant_token = current_tenant_id.set(tenant_id)
            try:
                row = (await db.execute(select(InvestorMatchRun).where(InvestorMatchRun.id == run_id).with_for_update())).scalar_one_or_none()
                if not row:
                    return True
                if row.status == "cancel_requested":
                    row.status, row.phase, row.completed_at = "cancelled", "cancelled", utcnow()
                    record_event(row, "cancelled")
                else:
                    row.candidates, row.cursor = candidates, 0
                    if direction == "companies_for_thesis":
                        results = [_company_result(item, row.thesis) for item in candidates]
                        results.sort(key=lambda item: (-item["score"], item["name"].lower()))
                        row.results = results[:row.limit]
                        row.phase = row.status = "completed"
                        row.completed_at = utcnow()
                        record_event(row, "sec_company_matches_selected", count=len(row.results), source_url=FORMD_URL)
                        record_event(row, "completed", count=len(row.results))
                    else:
                        row.phase = "research"
                        record_event(row, "sec_candidates_selected", count=len(candidates), source_url=FORMD_URL)
                    if not candidates and direction != "companies_for_thesis":
                        row.status, row.phase, row.completed_at = "completed", "completed", utcnow()
                        record_event(row, "completed", count=0)
                await db.commit()
            finally:
                current_tenant_id.reset(tenant_token)
        return True

    if phase == "research":
        if cursor >= len(candidates):
            async with sessions() as db:
                labels = await _get_labels(db, tenant_id)
                tenant_token = current_tenant_id.set(tenant_id)
                try:
                    row = (await db.execute(select(InvestorMatchRun).where(InvestorMatchRun.id == run_id).with_for_update())).scalar_one_or_none()
                    if row and row.status == "cancel_requested":
                        row.status, row.phase, row.completed_at = "cancelled", "cancelled", utcnow()
                        record_event(row, "cancelled")
                    elif row:
                        results = [_result(item, row.thesis, labels) for item in row.candidates]
                        results.sort(key=lambda item: (-item["score"], item["name"].lower()))
                        shortlist = results[:result_limit]
                        row.results = shortlist
                        row.status, row.phase, row.completed_at = "completed", "completed", utcnow()
                        record_event(row, "completed", count=len(shortlist))
                    await db.commit()
                finally:
                    current_tenant_id.reset(tenant_token)
            return True

        batch = candidates[cursor:cursor + 8]
        try:
            enriched = await _await_with_pulse(_profile_candidates(batch), pulse)
        except Exception:
            enriched = [{**item, "website_profile": None} for item in batch]
        async with sessions() as db:
            tenant_token = current_tenant_id.set(tenant_id)
            try:
                row = (await db.execute(select(InvestorMatchRun).where(InvestorMatchRun.id == run_id).with_for_update())).scalar_one_or_none()
                if not row:
                    return True
                if row.status == "cancel_requested":
                    row.status, row.phase, row.completed_at = "cancelled", "cancelled", utcnow()
                    record_event(row, "cancelled")
                else:
                    latest = list(row.candidates or [])
                    latest[cursor:cursor + len(enriched)] = enriched
                    row.candidates = latest
                    row.cursor = min(cursor + len(enriched), len(latest))
                    record_event(row, "website_batch_read", count=len(enriched), completed=row.cursor, total=len(latest))
                await db.commit()
            finally:
                current_tenant_id.reset(tenant_token)
        return True
    return False
