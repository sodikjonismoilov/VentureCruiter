"""Real independent-store races against a disposable local SQLite file.

SQLite's BEGIN IMMEDIATE substitutes its process-wide writer lock for the
PostgreSQL gate-row lock. No live database, credential or provider is used.
"""
import asyncio
import hashlib
import json
import time
from contextlib import asynccontextmanager
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, insert, select, update
from sqlalchemy.dialects.postgresql import dialect as postgres_dialect
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.api import atlas_engine as api
from app.config import settings
from app.main import app
from app.services.atlas_admission import (
    AdmissionDenied, AdmissionUnavailable, DurableAdmission, Lease,
    CLEANUP_BATCH, LEASE_GRACE_MS, MAX_INFLIGHT, NONCE_RETENTION_MS, SERVICE,
    digest, gate, initialize_admission_schema, metadata, nonces,
)
from app.services.llm_gateway import LLMGateway


@pytest.fixture(autouse=True)
def local_environment(monkeypatch):
    for name in ("VERCEL", "VERCEL_ENV", "VERCEL_DEPLOYMENT_ID", "NODE_ENV"):
        monkeypatch.delenv(name, raising=False)


@pytest_asyncio.fixture
async def stores(tmp_path):
    url = "sqlite+aiosqlite:///" + str(tmp_path / "shared-admission.db")
    engines = [create_async_engine(url, poolclass=NullPool, connect_args={"timeout": 2}) for _ in range(2)]
    async with engines[0].begin() as connection:
        await connection.run_sync(metadata.create_all)
    sessions = [async_sessionmaker(engine, expire_on_commit=False) for engine in engines]
    values = [DurableAdmission(session, engine, allow_sqlite=True) for session, engine in zip(sessions, engines)]
    yield values
    for engine in engines:
        await engine.dispose()


def args(**changes):
    return {"tenant_id": "synthetic-tenant", "actor_id": "synthetic-actor", "request_id": str(uuid4()), "raw_body": b"synthetic sensitive fixture body", "timeout_ms": 1000, **changes}


async def outcome(store, data):
    try:
        return await store.acquire(**data)
    except AdmissionDenied as error:
        return error


@pytest.mark.asyncio
async def test_same_nonce_racing_independent_instances_starts_once(stores):
    one, two = stores
    body = args()
    outcomes = await asyncio.gather(outcome(one, body), outcome(two, body))
    assert sum(isinstance(value, Lease) for value in outcomes) == 1
    denied = next(value for value in outcomes if isinstance(value, AdmissionDenied))
    assert (denied.status, denied.code) == (409, "request_replayed")
    lease = next(value for value in outcomes if isinstance(value, Lease))
    assert await two.release(lease)
    # Release frees concurrency, never replay permission after a lost response.
    with pytest.raises(AdmissionDenied, match="request_replayed"):
        await one.acquire(**body)
    changed = {**body, "raw_body": b"different body under same request UUID"}
    with pytest.raises(AdmissionDenied, match="request_conflict"):
        await two.acquire(**changed)


@pytest.mark.asyncio
async def test_shared_per_principal_limit_is_atomic_under_race(stores):
    outcomes = await asyncio.gather(*(outcome(stores[n % 2], args()) for n in range(12)))
    accepted = [value for value in outcomes if isinstance(value, Lease)]
    denied = [value for value in outcomes if isinstance(value, AdmissionDenied)]
    assert len(accepted) == 2 and len(denied) == 10
    assert all(value.status == 429 and value.code == "engine_busy" for value in denied)
    assert await stores[1].release(accepted[0])
    assert isinstance(await stores[0].acquire(**args()), Lease)


@pytest.mark.asyncio
async def test_shared_global_limit_is_atomic_across_principals(stores):
    outcomes = await asyncio.gather(*(outcome(stores[n % 2], args(actor_id=f"actor-{n}")) for n in range(24)))
    accepted = [value for value in outcomes if isinstance(value, Lease)]
    assert len(accepted) == MAX_INFLIGHT
    assert len([value for value in outcomes if isinstance(value, AdmissionDenied)]) == 8


@pytest.mark.asyncio
async def test_crash_expired_lease_frees_capacity_but_not_nonce(stores):
    first, second = stores
    original = args()
    a = await first.acquire(**original)
    await second.acquire(**args())
    with pytest.raises(AdmissionDenied): await first.acquire(**args())
    async with second.engine.begin() as connection:
        await connection.execute(update(nonces).where(nonces.c.nonce_hash == a.nonce_hash).values(lease_expires_at_ms=0))
    # Simulates worker death without a release: an independent process recovers
    # capacity from the database lease clock, while replay still stays denied.
    assert isinstance(await second.acquire(**args()), Lease)
    with pytest.raises(AdmissionDenied, match="request_replayed"): await first.acquire(**original)


@pytest.mark.asyncio
async def test_late_or_wrong_owner_cannot_release_new_lease(stores):
    first, second = stores
    data = args()
    old = await first.acquire(**data)
    assert not await second.release(replace(old, ownership_token="wrong-owner"))
    async with first.engine.begin() as connection:
        await connection.execute(update(nonces).where(nonces.c.nonce_hash == old.nonce_hash).values(lease_expires_at_ms=0, retain_until_ms=0))
    assert await second.cleanup() == 1
    newer = await second.acquire(**data)
    assert old.nonce_hash == newer.nonce_hash and old.ownership_token != newer.ownership_token
    assert not await first.release(old)
    async with second.engine.connect() as connection:
        assert (await connection.execute(select(nonces.c.released_at_ms).where(nonces.c.nonce_hash == newer.nonce_hash))).scalar_one() is None
    assert await first.release(newer)
    assert not await second.release(newer)


@pytest.mark.asyncio
async def test_only_hashes_and_finite_timestamps_are_persisted(stores):
    data = args(timeout_ms=30000)
    lease = await stores[0].acquire(**data)
    async with stores[1].engine.connect() as connection:
        record = (await connection.execute(select(nonces).where(nonces.c.nonce_hash == lease.nonce_hash))).mappings().one()
    assert "synthetic sensitive" not in repr(record)
    assert data["tenant_id"] not in repr(record) and data["actor_id"] not in repr(record) and data["request_id"] not in repr(record)
    assert record["body_hash"] == hashlib.sha256(data["raw_body"]).hexdigest()
    assert record["ownership_hash"] != lease.ownership_token
    assert record["retain_until_ms"] - record["admitted_at_ms"] == NONCE_RETENTION_MS
    assert record["lease_expires_at_ms"] - record["admitted_at_ms"] == 30000 + LEASE_GRACE_MS


@pytest.mark.asyncio
async def test_bounded_cleanup_makes_progress_and_preserves_live_nonce(stores):
    first, second = stores
    keep = await first.acquire(**args())
    expired = [{"nonce_hash": digest("expired", n), "service": SERVICE, "principal_hash": digest("principal", n), "body_hash": digest("body", n), "ownership_hash": digest("owner", n), "admitted_at_ms": 0, "lease_expires_at_ms": 0, "retain_until_ms": 0} for n in range(CLEANUP_BATCH + 3)]
    async with first.engine.begin() as connection:
        await connection.execute(insert(nonces), expired)
    assert await second.cleanup() == CLEANUP_BATCH
    assert await first.cleanup() == 3
    async with second.engine.connect() as connection:
        assert await connection.scalar(select(func.count()).select_from(nonces)) == 1
        assert await connection.scalar(select(nonces.c.nonce_hash)) == keep.nonce_hash


@pytest.mark.asyncio
async def test_commit_uncertainty_never_grants_inference_or_allows_replay(stores):
    good = stores[0]
    @asynccontextmanager
    async def uncertain_session():
        async with good.sessions() as session:
            commit = session.commit
            async def uncertain_commit():
                await commit()
                raise OSError("Synthetic lost database commit acknowledgement")
            session.commit = uncertain_commit
            yield session
    ambiguous = DurableAdmission(uncertain_session, good.engine, allow_sqlite=True)
    data = args()
    with pytest.raises(AdmissionUnavailable, match="could not be confirmed"):
        await ambiguous.acquire(**data)
    with pytest.raises(AdmissionDenied, match="request_replayed"):
        await stores[1].acquire(**data)


@pytest.mark.asyncio
async def test_postgres_mode_rejects_sqlite():
    # A real route test below proves there is no automatic in-memory fallback.
    engine = create_async_engine("sqlite+aiosqlite://")
    try:
        strict = DurableAdmission(async_sessionmaker(engine), engine)
        with pytest.raises(AdmissionUnavailable, match="PostgreSQL"):
            await strict.acquire(**args())
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_missing_shared_schema_is_safe_unavailable(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///" + str(tmp_path / "missing-schema.db"))
    store = DurableAdmission(async_sessionmaker(engine), engine, allow_sqlite=True)
    try:
        with pytest.raises(AdmissionUnavailable): await store.acquire(**args())
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_api_fail_closed_for_missing_store_and_forbidden_local_mode(monkeypatch):
    import hmac
    key = "synthetic-engine-admission-signing-key"
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ENABLED", True)
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_PROVIDER", "gemini")
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_MODEL", "gemini-3.8-flash")
    monkeypatch.setattr(settings, "ATLAS_ENGINE_SIGNING_KEY", key)
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ADMISSION", "postgres")
    calls = []
    async def forbidden(*args, **kwargs):
        calls.append(True)
        yield
    monkeypatch.setattr(LLMGateway, "stream", forbidden)
    body = {"version": 1, "requestId": str(uuid4()), "principal": {"tenantId": "fixture", "actorId": "actor"}, "recipient": "gemini", "messages": [{"role": "user", "content": "Synthetic private fixture"}]}
    raw = json.dumps(body).encode()
    stamp = str(int(time.time()))
    signature = hmac.new(key.encode(), b"v1\n" + stamp.encode() + b"\n" + raw, hashlib.sha256).hexdigest()
    headers = {"content-type": "application/json", "x-atlas-engine-timestamp": stamp, "x-atlas-engine-signature": signature}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/integrations/atlas/v1/chat", content=raw, headers=headers)
        assert response.status_code == 503 and response.json()["code"] == "engine_admission_unavailable"
        monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ADMISSION", "local-memory")
        monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ALLOW_LOCAL_ADMISSION", False)
        assert (await client.post("/api/integrations/atlas/v1/chat", content=raw, headers=headers)).status_code == 503
        monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ALLOW_LOCAL_ADMISSION", True)
        monkeypatch.setenv("VERCEL_ENV", "production")
        assert (await client.post("/api/integrations/atlas/v1/chat", content=raw, headers=headers)).status_code == 503
    assert calls == []


@pytest.mark.asyncio
async def test_schema_bootstrap_is_separate_and_disabled_by_default(monkeypatch):
    from app.db.session import Base
    assert nonces.name not in {table.name for table in Base.metadata.tables.values()}
    called = []
    class Connection:
        async def run_sync(self, operation): called.append(operation)
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ENABLED", False)
    await initialize_admission_schema(Connection())
    assert called == []


def test_postgres_gate_lock_sql_is_row_exclusive():
    statement = str(select(gate.c.revision).where(gate.c.service == SERVICE).with_for_update().compile(dialect=postgres_dialect()))
    assert "FOR UPDATE" in statement and "atlas_engine_admission_gate" in statement


@pytest.mark.asyncio
async def test_old_workspace_revision_fast_path_still_bootstraps_opted_in_admission(monkeypatch):
    from types import SimpleNamespace
    from app.db.bootstrap import initialize_database
    called = []
    class Connection:
        dialect = SimpleNamespace(name="postgresql")
        async def execute(self, statement): called.append(str(statement))
        async def scalar(self, statement):
            if 'SELECT version' in str(statement):
                return "2026-10-21-workspace-computer-v3"
            return None
        async def run_sync(self, operation): called.append(operation)
    @asynccontextmanager
    async def begin(): yield Connection()
    database = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"), begin=begin)
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ENABLED", True)
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ADMISSION", "postgres")
    await initialize_database(database)
    assert metadata.create_all in called


@pytest.mark.asyncio
async def test_local_memory_is_rejected_for_public_origin_even_without_host_env(monkeypatch):
    from app.services.atlas_admission import local_admission_allowed
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ALLOW_LOCAL_ADMISSION", True)
    monkeypatch.setattr(settings, "GROKBOT_PUBLIC_URL", "https://public-fixture.example")
    assert not local_admission_allowed()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["acquire", "cleanup", "release"])
async def test_store_timeout_also_bounds_rollback_and_session_finalization(monkeypatch, operation):
    from types import SimpleNamespace
    from app.services import atlas_admission as module
    monkeypatch.setattr(module, "STORE_TIMEOUT_SECONDS", .02)
    monkeypatch.setattr(module, "STORE_CLEANUP_SECONDS", .01)
    called = []
    class StalledSession:
        async def __aenter__(self): return self
        async def __aexit__(self, *args):
            called.append("close")
            await asyncio.sleep(5)
        async def rollback(self):
            called.append("rollback")
            await asyncio.sleep(5)
    store = DurableAdmission(StalledSession, SimpleNamespace(dialect=SimpleNamespace(name="postgresql")))
    async def stalled(*args): await asyncio.sleep(5)
    monkeypatch.setattr(store, "_begin", stalled)
    before = time.monotonic()
    with pytest.raises(AdmissionUnavailable):
        async with asyncio.timeout(.3):
            if operation == "acquire": await store.acquire(**args())
            elif operation == "cleanup": await store.cleanup()
            else: await store.release(Lease(digest("fake"), "fake-owner"))
    assert called == ["rollback", "close"]
    assert time.monotonic() - before < .2


@pytest.mark.asyncio
async def test_confirmed_commit_with_stalled_finalization_still_fails_closed(stores, monkeypatch):
    from app.services import atlas_admission as module
    monkeypatch.setattr(module, "STORE_CLEANUP_SECONDS", .01)
    good = stores[0]
    @asynccontextmanager
    async def stalled_close():
        async with good.sessions() as session:
            yield session
        await asyncio.sleep(5)
    bad = DurableAdmission(stalled_close, good.engine, allow_sqlite=True)
    data = args()
    with pytest.raises(AdmissionUnavailable):
        await bad.acquire(**data)
    with pytest.raises(AdmissionDenied, match="request_replayed"):
        await stores[1].acquire(**data)


@pytest.mark.asyncio
async def test_signed_http_shared_store_race_starts_once_and_releases_owned_lease(stores, monkeypatch):
    import hmac
    key = "synthetic-shared-store-route-signing-key"
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ENABLED", True)
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_PROVIDER", "gemini")
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_MODEL", "gemini-3.8-flash")
    monkeypatch.setattr(settings, "ATLAS_ENGINE_SIGNING_KEY", key)
    monkeypatch.setattr(settings, "GROKBOT_ATLAS_ENGINE_ADMISSION", "postgres")
    monkeypatch.setattr(api, "durable_admission", stores[0])
    started = []
    async def provider(*args, **kwargs):
        started.append(True)
        await asyncio.sleep(.03)
        yield {"choices": [{"delta": {"content": "Synthetic fixture answer"}, "finish_reason": "stop"}]}
    monkeypatch.setattr(LLMGateway, "stream", provider)
    request_id = str(uuid4())
    body = {"version": 1, "requestId": request_id, "principal": {"tenantId": "fixture", "actorId": "actor"}, "recipient": "gemini", "messages": [{"role": "user", "content": "Synthetic fixture question"}]}
    raw = json.dumps(body).encode()
    stamp = str(int(time.time()))
    signature = hmac.new(key.encode(), b"v1\n" + stamp.encode() + b"\n" + raw, hashlib.sha256).hexdigest()
    headers = {"content-type": "application/json", "x-atlas-engine-timestamp": stamp, "x-atlas-engine-signature": signature}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        responses = await asyncio.gather(*(client.post("/api/integrations/atlas/v1/chat", content=raw, headers=headers) for _ in range(2)))
        assert sorted(response.status_code for response in responses) == [200, 409]
        assert (await client.post("/api/integrations/atlas/v1/chat", content=raw, headers=headers)).status_code == 409
    assert started == [True]
    async with stores[1].engine.connect() as connection:
        row = (await connection.execute(select(nonces).where(nonces.c.nonce_hash == digest(SERVICE, "fixture", "actor", request_id)))).mappings().one()
    assert row["released_at_ms"] is not None
    assert row["body_hash"] == hashlib.sha256(raw).hexdigest()
