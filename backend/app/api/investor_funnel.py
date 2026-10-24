"""VC investor matching endpoints for Cypher's authenticated workspaces."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.db.tenancy import current_tenant_id
from app.models.investor_funnel import FounderArchiveBackfill, InvestorMatchLabel, InvestorMatchRun, InvestorUniverseSnapshot, utcnow
from app.models.user import User
from app.services.investor_funnel import enqueue_founder_archive, founder_archive_state, get_founder_archive_state, prepare_outreach, record_event, search_founder_leads, sec_user_agent, snapshot

router = APIRouter()


def authenticated():
    tenant = current_tenant_id.get()
    if not tenant:
        raise HTTPException(401, "Sign in to use VC investor matching.")
    return tenant


class MatchInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    direction: Literal["investors_for_thesis", "companies_for_thesis"] = "investors_for_thesis"
    one_liner: str = Field(min_length=4, max_length=300)
    thesis: str = Field(min_length=20, max_length=4000)
    beliefs: list[str] = Field(default_factory=list, max_length=10)
    keywords: list[str] = Field(default_factory=list, max_length=40)
    industries: list[str] = Field(default_factory=list, max_length=20)
    competitors: list[str] = Field(default_factory=list, max_length=30)
    exclusions: list[str] = Field(default_factory=list, max_length=30)
    stage: str = Field(default="seed", min_length=1, max_length=40)
    raise_usd: int | None = Field(default=None, ge=0, le=10_000_000_000)
    fund_size_usd: tuple[int, int] = (15_000_000, 500_000_000)
    geo_preferred: list[str] = Field(default_factory=list, max_length=30)
    geo_required: list[str] = Field(default_factory=list, max_length=30)
    max_months_since_fund: int = Field(default=36, ge=1, le=120)
    limit: int = Field(default=15, ge=1, le=20)
    candidate_limit: int = Field(default=80, ge=20, le=200)

    @field_validator("fund_size_usd")
    @classmethod
    def valid_fund_range(cls, value):
        if value[0] <= 0 or value[1] < value[0]:
            raise ValueError("fund_size_usd must be [minimum, maximum] in ascending order")
        return value

    @field_validator("beliefs", "keywords", "industries", "competitors", "exclusions", "geo_preferred", "geo_required")
    @classmethod
    def clean_lists(cls, values):
        return [value.strip() for value in values if isinstance(value, str) and value.strip()]

    @field_validator("geo_preferred", "geo_required")
    @classmethod
    def normalize_geography(cls, values):
        return [value.upper() for value in values]

    @field_validator("thesis")
    @classmethod
    def require_specific_thesis(cls, value):
        if len(value) < 20:
            raise ValueError("thesis must contain at least 20 characters of specific investment criteria")
        return value


class LabelInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    label: Literal[-1, 1]
    note: str = Field(default="", max_length=500)


async def owned(db, run_id, tenant):
    row = (await db.execute(select(InvestorMatchRun).where(
        InvestorMatchRun.id == run_id,
        InvestorMatchRun.tenant_id == tenant,
    ))).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Investor matching run not found.")
    return row


async def as_snapshot(db, row):
    cache = await db.get(InvestorUniverseSnapshot, "current")
    return snapshot(row, cache)


@router.get("/founders")
async def search_founders(
    q: str | None = Query(default=None, max_length=120),
    industry: str | None = Query(default=None, max_length=160),
    state: str | None = Query(default=None, max_length=80),
    founder_only: bool = False,
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=100000),
    tenant=Depends(authenticated),
    db: AsyncSession = Depends(get_db),
):
    query = (q or "").strip()
    if len(query) == 1:
        raise HTTPException(422, "Search query must contain at least two characters.")
    return await search_founder_leads(db, query, industry, state, founder_only, limit, offset)


@router.get("/founders/backfill")
async def founder_backfill_status(tenant=Depends(authenticated), db: AsyncSession = Depends(get_db)):
    return await get_founder_archive_state(db)


@router.post("/founders/backfill", status_code=202)
async def start_founder_backfill(tenant=Depends(authenticated), db: AsyncSession = Depends(get_db)):
    user = await db.get(User, tenant)
    if user is None or not sec_user_agent(user.email):
        raise HTTPException(401, "Sign in with a verified email address before importing SEC public data.")
    current = await db.get(FounderArchiveBackfill, "historical")
    if current and current.status == "completed":
        # Re-run the terminal coverage check from the existing cursor.
        current.requested_by = tenant
        current.status = "pending"
        current.error = None
        current.completed_at = None
        await db.commit()
        await db.refresh(current)
        return founder_archive_state(current)
    if current and current.status in {"pending", "running"}:
        return founder_archive_state(current)
    return await enqueue_founder_archive(db, tenant)


@router.post("/runs", status_code=202)
async def create_run(body: MatchInput, tenant=Depends(authenticated), db: AsyncSession = Depends(get_db)):
    cache = await db.get(InvestorUniverseSnapshot, "current")
    fresh = bool(cache and cache.built_at and (utcnow() - cache.built_at).days < 90)
    if not fresh:
        user = await db.get(User, tenant)
        if user is None or not sec_user_agent(user.email):
            raise HTTPException(401, "Sign in with a verified email address before refreshing SEC public data.")
    active = (await db.execute(select(InvestorMatchRun.id).where(
        InvestorMatchRun.tenant_id == tenant,
        InvestorMatchRun.status.in_(["pending", "running", "cancel_requested"]),
    ).limit(3))).scalars().all()
    if len(active) >= 3:
        raise HTTPException(429, "Finish or cancel an existing investor match run before starting another.")
    values = body.model_dump()
    direction = values.pop("direction")
    thesis = {key: value for key, value in values.items() if key not in {"limit", "candidate_limit"}}
    row = InvestorMatchRun(direction=direction, thesis=thesis, limit=body.limit, candidate_limit=body.candidate_limit)
    db.add(row)
    record_event(row, "queued", source="SEC Form ADV and Form D", snapshot_cached=fresh)
    await db.commit()
    await db.refresh(row)
    return await as_snapshot(db, row)


@router.get("/runs")
async def list_runs(tenant=Depends(authenticated), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(InvestorMatchRun).where(
        InvestorMatchRun.tenant_id == tenant,
    ).order_by(InvestorMatchRun.created_at.desc()).limit(50))).scalars().all()
    cache = await db.get(InvestorUniverseSnapshot, "current")
    return [snapshot(row, cache) for row in rows]


@router.get("/runs/{run_id}")
async def get_run(run_id: str, tenant=Depends(authenticated), db: AsyncSession = Depends(get_db)):
    return await as_snapshot(db, await owned(db, run_id, tenant))


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, tenant=Depends(authenticated), db: AsyncSession = Depends(get_db)):
    row = await owned(db, run_id, tenant)
    if row.status not in {"completed", "partial", "failed", "cancelled"}:
        row.status = "cancel_requested"
        await db.commit()
        await db.refresh(row)
    return await as_snapshot(db, row)


@router.post("/runs/{run_id}/results/{firm_id}/label")
async def label_result(run_id: str, firm_id: str, body: LabelInput, tenant=Depends(authenticated), db: AsyncSession = Depends(get_db)):
    row = await owned(db, run_id, tenant)
    if row.direction != "investors_for_thesis":
        raise HTTPException(409, "Workspace firm ratings apply to investor matches only.")
    if row.status not in {"completed", "partial"}:
        raise HTTPException(409, "Wait for the matching run to finish before rating a firm.")
    if not any(result.get("id") == firm_id for result in (row.results or [])):
        raise HTTPException(404, "Matched investor was not found in this run.")
    label = (await db.execute(select(InvestorMatchLabel).where(
        InvestorMatchLabel.tenant_id == tenant,
        InvestorMatchLabel.firm_id == firm_id,
    ).limit(1))).scalar_one_or_none()
    if label is None:
        label = InvestorMatchLabel(firm_id=firm_id, label=body.label, note=body.note)
        db.add(label)
    else:
        label.label, label.note, label.updated_at = body.label, body.note, utcnow()
    await db.commit()
    return {"firm_id": firm_id, "label": body.label, "note": body.note, "saved": True}


@router.post("/runs/{run_id}/results/{result_id}/outreach")
async def prepare_result_outreach(run_id: str, result_id: str, tenant=Depends(authenticated), db: AsyncSession = Depends(get_db)):
    row = await owned(db, run_id, tenant)
    if row.status not in {"completed", "partial"}:
        raise HTTPException(409, "Wait for the matching run to finish before preparing outreach.")
    result = next((item for item in (row.results or []) if item.get("id") == result_id), None)
    if result is None:
        raise HTTPException(404, "Matched company or investor was not found in this run.")
    return prepare_outreach(row, result)
