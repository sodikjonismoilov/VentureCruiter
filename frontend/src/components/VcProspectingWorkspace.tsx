'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { request } from '../lib/api';
import CypherMark from './cipher/CypherMark';
import './vc-prospecting.css';

type Founder = {
  id: string; person_name: string; company_name: string; title: string; roles: string[];
  founder_status: string; founder_evidence: string | null; industry: string | null;
  location: { city: string | null; state: string | null };
  filing_date: string | null; filing_count_in_snapshot: number; source_quarters: string[];
  source_url: string;
};
type FounderHistory = { status: 'idle' | 'pending' | 'running' | 'completed' | 'failed'; total_quarters: number; processed_quarters: number; current_quarter: string | null; error: string | null; started_at?: string | null; completed_at?: string | null };
type FounderPage = {
  database: { records: number; explicit_founder_signals: number; matched_records: number; snapshot_ready: boolean; snapshot_built_at: string | null; quarters: string[]; quarter_count: number; historical: FounderHistory; source: string };
  items: Founder[]; page: { limit: number; offset: number; returned: number }; next_step?: string; limitations: string[];
};
type MatchResult = { id: string; name: string; score?: number; reasons?: string[]; reason?: string; source_url?: string; website?: string; sources?: { label: string; url: string }[]; city?: string; state?: string; industry?: string; [key: string]: unknown };
type MatchRun = {
  id: string; direction: 'investors_for_thesis' | 'companies_for_thesis'; thesis: { one_liner?: string; thesis?: string };
  status: string; phase: string; results: MatchResult[]; events: { type: string; at: string; count?: number; source_url?: string; [key: string]: unknown }[];
  source_snapshot: { firm_count: number; built_at: string | null } | null; error?: { code?: string; detail?: string } | null;
  limitations: string[];
};
type Outreach = {
  subject: string; body: string; recipient: string; status: string; sending: string;
  meeting_brief: { goal: string; public_signals: string[]; questions: string[]; before_sending: string[]; sources: { label: string; url: string }[] };
};

const terminal = (status: string) => ['completed', 'partial', 'failed', 'cancelled'].includes(status);
const ACTIVE = new Set(['pending', 'running', 'cancel_requested']);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Try again.';
const dateLabel = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString() : 'Not refreshed yet';

export default function VcProspectingWorkspace() {
  const [data, setData] = useState<FounderPage | null>(null);
  const [runs, setRuns] = useState<MatchRun[]>([]);
  const [run, setRun] = useState<MatchRun | null>(null);
  const [query, setQuery] = useState('');
  const [industry, setIndustry] = useState('');
  const [state, setState] = useState('');
  const [founderOnly, setFounderOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [direction, setDirection] = useState<MatchRun['direction']>('companies_for_thesis');
  const [oneLiner, setOneLiner] = useState('Recent SEC Form D startup leads');
  const [thesis, setThesis] = useState('Source recent SEC Form D issuer filings across industries for venture investor research. Treat filing-named people as related persons; label someone as a founder only when a filing explicitly says founder or co-founder. Do not contact anyone or add personal contact details.');
  const [industries, setIndustries] = useState('');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startingHistory, setStartingHistory] = useState(false);
  const [drafting, setDrafting] = useState('');
  const [outreach, setOutreach] = useState<{ resultId: string; value: Outreach } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadFounders = useCallback(async (nextOffset: number, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (industry.trim()) params.set('industry', industry.trim());
    if (state.trim()) params.set('state', state.trim());
    if (founderOnly) params.set('founder_only', 'true');
    params.set('limit', '25');
    params.set('offset', String(nextOffset));
    const next: FounderPage = await request(`/prospecting/investors/founders?${params.toString()}`, { signal });
    setData(next);
    setOffset(nextOffset);
    return next;
  }, [founderOnly, industry, query, state]);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    const rows: MatchRun[] = await request('/prospecting/investors/runs', { signal });
    setRuns(rows);
    setRun(current => current || rows[0] || null);
    return rows;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ limit: '25', offset: '0' });
    Promise.all([
      request(`/prospecting/investors/founders?${params.toString()}`, { signal: controller.signal }) as Promise<FounderPage>,
      loadRuns(controller.signal),
    ]).then(([next]) => { if (!controller.signal.aborted) setData(next); })
      .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [loadRuns]); // Initial load only; searches are submitted explicitly.

  useEffect(() => {
    if (!run?.id || !ACTIVE.has(run.status)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next: MatchRun = await request(`/prospecting/investors/runs/${encodeURIComponent(run.id)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRun(next);
        setRuns(rows => [next, ...rows.filter(item => item.id !== next.id)]);
        if (ACTIVE.has(next.status)) timer = setTimeout(poll, 3000);
        else {
          await loadFounders(0, controller.signal);
          setNotice(next.status === 'completed' || next.status === 'partial' ? 'SEC snapshot and match results are ready.' : 'The run stopped before producing results.');
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(errorMessage(failure));
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [loadFounders, run?.id, run?.status]);

  useEffect(() => {
    const status = data?.database.historical.status;
    if (!status || !['pending', 'running'].includes(status)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next: FounderHistory = await request('/prospecting/investors/founders/backfill', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(current => current ? { ...current, database: { ...current.database, historical: next } } : current);
        if (['pending', 'running'].includes(next.status)) timer = setTimeout(poll, 5000);
        else if (next.status === 'completed') {
          await loadFounders(0);
          setNotice('Historical SEC Form D archive is indexed and searchable.');
        } else if (next.error) setError(next.error);
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [data?.database.historical.status, loadFounders]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length === 1) { setError('Search with at least two characters.'); return; }
    setSearching(true); setError(''); setNotice('');
    try { await loadFounders(0); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setSearching(false); }
  }

  async function createRun(payload: { direction: MatchRun['direction']; one_liner: string; thesis: string; industries?: string[]; limit: number; candidate_limit: number }) {
    if (starting) return;
    setStarting(true); setError(''); setNotice(''); setOutreach(null);
    try {
      const next: MatchRun = await request('/prospecting/investors/runs', { method: 'POST', body: JSON.stringify(payload) }, 45000);
      setRun(next);
      setRuns(rows => [next, ...rows.filter(item => item.id !== next.id)]);
      setNotice(next.source_snapshot ? 'Match queued using Cypher’s recent SEC snapshot.' : 'SEC refresh queued. The worker will download, parse and index the filing records in the background.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setStarting(false); }
  }

  async function startMatch(event: FormEvent) {
    event.preventDefault();
    const cleanedIndustries = industries.split(',').map(value => value.trim()).filter(Boolean).slice(0, 20);
    await createRun({ direction, one_liner: oneLiner.trim(), thesis: thesis.trim(), industries: cleanedIndustries, limit: 15, candidate_limit: 80 });
  }

  async function startSecRefresh() {
    await createRun({
      direction: 'companies_for_thesis', one_liner: 'Recent SEC Form D startup founder and issuer leads',
      thesis: 'Build a broad research set from the recent SEC Form D issuer filings across industries. Include named filing-related persons as public leads and label a person as founder only when the filed title or role explicitly says founder or co-founder. This run is for VC sourcing and database refresh; do not contact anyone or add personal contact details.',
      limit: 20, candidate_limit: 80,
    });
  }

  async function startHistoricalImport() {
    if (startingHistory) return;
    setStartingHistory(true); setError(''); setNotice('');
    try {
      const history: FounderHistory = await request('/prospecting/investors/founders/backfill', { method: 'POST' }, 45000);
      setData(current => current ? { ...current, database: { ...current.database, historical: history } } : current);
      if (history.status === 'completed') setNotice('SEC archive coverage is already complete.');
      else if (history.status === 'running' || history.status === 'pending') setNotice('Historical SEC archives are being indexed in resumable quarterly batches.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setStartingHistory(false); }
  }

  async function prepareOutreach(result: MatchResult) {
    if (!run || drafting) return;
    setDrafting(result.id); setError(''); setOutreach(null);
    try {
      const value: Outreach = await request(`/prospecting/investors/runs/${encodeURIComponent(run.id)}/results/${encodeURIComponent(result.id)}/outreach`, { method: 'POST' });
      setOutreach({ resultId: result.id, value });
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setDrafting(''); }
  }

  const activeRun = !!run && ACTIVE.has(run.status);
  return <main className="vc-page">
    <header className="vc-topbar">
      <a className="vc-brand" href="/" aria-label="Cypher home"><CypherMark className="vc-brand-mark" decorative /></a>
      <nav aria-label="Prospecting"><a href="/prospecting">Company prospecting</a><span>VC intelligence</span></nav>
    </header>

    <section className="vc-hero">
      <h1>VC intelligence</h1>
      <p>Find investors for a company, source issuers for a fund thesis, and search people named in SEC Form D filings.</p>
    </section>

    <section className="vc-source-summary" aria-label="SEC database status">
      <strong>SEC Form D index</strong>
      <span>{loading ? 'Loading counts' : `${(data?.database.records ?? 0).toLocaleString()} named person–company records`}</span>
      <span>{loading ? 'Loading founder signals' : `${(data?.database.explicit_founder_signals ?? 0).toLocaleString()} explicit founder signals`}</span>
      <span>{loading ? 'Checking snapshot' : `Last refreshed ${dateLabel(data?.database.snapshot_built_at)}`}</span>
      <span>{loading ? 'Loading quarters' : `${data?.database.quarter_count ?? 0} of the SEC’s published quarters indexed`}</span>
    </section>

    {error ? <div className="vc-alert" role="alert">{error}</div> : null}
    {notice ? <div className="vc-notice" role="status">{notice}</div> : null}

    <section className="vc-refresh-card">
      <div>
        <h2>{data?.database.snapshot_ready ? 'Refresh the public SEC snapshot' : 'Build the founder and issuer index'}</h2>
        <p>Cypher reads the SEC’s latest eight Form D quarters and current Form ADV files, then indexes the named issuer-related people for search.</p>
      </div>
      <button type="button" onClick={() => void startSecRefresh()} disabled={starting || activeRun}>
        {starting ? 'Queueing…' : activeRun ? 'SEC run in progress' : data?.database.snapshot_ready ? 'Refresh SEC data' : 'Pull SEC data'}
      </button>
    </section>

    <section className="vc-refresh-card vc-history-card" aria-live="polite">
      <div>
        <h2>{data?.database.historical.status === 'completed' ? 'Historical founder and issuer index' : 'Expand the index to SEC history'}</h2>
        <p>Import SEC Form D quarterly archives from January 2008 onward. Cypher saves each quarter as it finishes, resumes safely after interruptions, and keeps founder labels tied to explicit filing evidence.</p>
        {data?.database.historical.status === 'running' || data?.database.historical.status === 'pending' ? <p className="vc-history-progress">{data.database.historical.processed_quarters.toLocaleString()} / {data.database.historical.total_quarters.toLocaleString()} historical quarters indexed{data.database.historical.current_quarter ? ` · working on ${data.database.historical.current_quarter.toUpperCase()}` : ''}</p> : null}
        {data?.database.historical.status === 'failed' && data.database.historical.error ? <p className="vc-inline-error">{data.database.historical.error}</p> : null}
        {data?.database.historical.status === 'completed' ? <p className="vc-history-progress">Complete · {data.database.quarter_count.toLocaleString()} SEC quarters indexed</p> : null}
      </div>
      <button type="button" onClick={() => void startHistoricalImport()} disabled={startingHistory || ['pending', 'running'].includes(data?.database.historical.status || 'idle')}>
        {startingHistory ? 'Queueing…' : data?.database.historical.status === 'running' || data?.database.historical.status === 'pending' ? 'Historical import in progress' : data?.database.historical.status === 'completed' ? 'Check SEC archive coverage' : data?.database.historical.status === 'failed' ? 'Resume historical import' : 'Import SEC history'}
      </button>
    </section>

    {run ? <section className="vc-run-card" aria-live="polite">
      <div className="vc-run-heading">
        <div><h2>{run.thesis?.one_liner || 'VC research run'}</h2></div>
        <span className={`vc-status ${terminal(run.status) ? 'is-done' : 'is-live'}`}>{run.status.replaceAll('_', ' ')}</span>
      </div>
      <p className="vc-run-phase">{run.phase.replaceAll('_', ' ')}{activeRun ? ' · Working in the background' : ''}</p>
      {run.error?.detail ? <p className="vc-inline-error">{run.error.detail}</p> : null}
      {run.events?.length ? <details className="vc-events"><summary>Source activity ({run.events.length})</summary><ul>{run.events.slice(-8).reverse().map((event, index) => <li key={`${event.at}-${event.type}-${index}`}><span>{event.type.replaceAll('_', ' ')}</span>{typeof event.count === 'number' ? <small>{event.count.toLocaleString()}</small> : null}{event.source_url ? <a href={event.source_url} target="_blank" rel="noreferrer">source</a> : null}</li>)}</ul></details> : null}
      {run.results?.length ? <div className="vc-match-results"><h3>{run.direction === 'companies_for_thesis' ? 'Company matches' : 'Investor matches'}</h3>{run.results.map(result => <article className="vc-match-row" key={result.id}>
        <div><strong>{result.name}</strong><p>{String(result.reason || (Array.isArray(result.reasons) ? result.reasons.join(' · ') : '') || result.industry || 'Public filing match')}</p></div>
        {typeof result.score === 'number' ? <span>{Math.round(result.score)}% fit</span> : null}
        {result.source_url || result.sources?.[0]?.url || result.website ? <a href={String(result.source_url || result.sources?.[0]?.url || result.website)} target="_blank" rel="noreferrer">Source</a> : null}
        <button type="button" onClick={() => void prepareOutreach(result)} disabled={!!drafting || !terminal(run.status)}>{drafting === result.id ? 'Preparing…' : 'Prepare outreach'}</button>
        {outreach?.resultId === result.id ? <div className="vc-outreach">
          <strong>Draft for review · not sent</strong>
          <p><b>{outreach.value.subject}</b></p><pre>{outreach.value.body}</pre>
          <h4>Meeting preparation</h4><p>{outreach.value.meeting_brief.goal}</p>
          {outreach.value.meeting_brief.public_signals.length ? <><b>Public signals</b><ul>{outreach.value.meeting_brief.public_signals.map((signal, index) => <li key={`${index}-${signal}`}>{signal}</li>)}</ul></> : null}
          <b>Questions to cover</b><ul>{outreach.value.meeting_brief.questions.map((question, index) => <li key={`${index}-${question}`}>{question}</li>)}</ul>
          <b>Before sending</b><ul>{outreach.value.meeting_brief.before_sending.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
          <p>{outreach.value.meeting_brief.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label}</a>)}</p>
          <small>{outreach.value.sending}</small>
        </div> : null}
      </article>)}</div> : null}
      {run.limitations?.length ? <p className="vc-limitations">{run.limitations[0]}</p> : null}
    </section> : null}

    <section className="vc-layout">
      <section className="vc-panel vc-match-panel">
        <div className="vc-panel-heading"><div><h2>Start a VC search</h2></div></div>
        <form className="vc-form" onSubmit={startMatch}>
          <label>Search direction<select value={direction} onChange={event => setDirection(event.target.value as MatchRun['direction'])}><option value="companies_for_thesis">Find companies for a VC thesis</option><option value="investors_for_thesis">Find investors for a company</option></select></label>
          <label>One-line brief<input value={oneLiner} onChange={event => setOneLiner(event.target.value)} minLength={4} maxLength={300} required /></label>
          <label>Investment thesis<textarea value={thesis} onChange={event => setThesis(event.target.value)} minLength={20} maxLength={4000} rows={5} required /></label>
          <label>Industries <span>(optional, comma-separated)</span><input value={industries} onChange={event => setIndustries(event.target.value)} placeholder="AI, healthcare, climate" /></label>
          <button className="vc-primary" type="submit" disabled={starting || activeRun || oneLiner.trim().length < 4 || thesis.trim().length < 20}>{starting ? 'Queueing…' : 'Start match'}</button>
        </form>
        <p className="vc-footnote">Uses public SEC filings and public fund information. Match scores are a first-pass screen; review sources before acting.</p>
      </section>

      <section className="vc-panel vc-founders-panel">
        <div className="vc-panel-heading"><div><h2>Founder and issuer leads</h2></div><button className="vc-text-button" type="button" onClick={() => void loadFounders(0).catch(failure => setError(errorMessage(failure)))} disabled={loading || searching}>Reload</button></div>
        <form className="vc-search" onSubmit={search}>
          <label className="vc-search-query">Search name, company or title<input value={query} onChange={event => setQuery(event.target.value)} placeholder="e.g. robotics, Jane Smith" /></label>
          <label>Industry<input value={industry} onChange={event => setIndustry(event.target.value)} placeholder="Any" /></label>
          <label>State<input value={state} onChange={event => setState(event.target.value)} placeholder="Any" maxLength={80} /></label>
          <label className="vc-checkbox"><input type="checkbox" checked={founderOnly} onChange={event => setFounderOnly(event.target.checked)} /> Explicit founder titles only</label>
          <button className="vc-secondary" type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
        </form>
        <div className="vc-data-source"><span className="vc-source-dot" />SEC Form D public data{data?.database.quarters.length ? <span>· latest indexed: {data.database.quarters.join(', ').toUpperCase()}</span> : null}</div>
        <div className="vc-founder-list" aria-live="polite">
          {loading ? <p className="vc-empty">Loading founder index…</p> : data?.items.length ? data.items.map(item => {
            const founderSignal = item.founder_status === 'founder_named_in_filing';
            const filingCount = item.filing_count_in_snapshot || 1;
            return <article className="vc-founder-row" key={item.id}>
            <div className="vc-founder-copy"><div className="vc-founder-title"><strong>{item.person_name}</strong><span className={founderSignal ? 'vc-founder-badge' : 'vc-related-badge'}>{founderSignal ? 'Founder signal' : 'Related person'}</span></div><p>{item.title || item.roles.join(' · ') || 'Role not specified'} · {item.company_name}</p><small>{[item.industry, [item.location?.city, item.location?.state].filter(Boolean).join(', '), item.filing_date, `${filingCount} SEC filing${filingCount === 1 ? '' : 's'} indexed`].filter(Boolean).join(' · ')}</small>{founderSignal && item.founder_evidence ? <small>Filed evidence: {item.founder_evidence}</small> : null}</div>
            {item.source_url ? <a href={item.source_url} target="_blank" rel="noreferrer">SEC filing</a> : null}
          </article>}) : <div className="vc-empty"><h3>{data?.database.snapshot_ready ? 'No matching people' : 'No SEC snapshot yet'}</h3><p>{data?.database.snapshot_ready ? 'Try a broader search or clear the filters.' : 'Pull the public SEC dataset above to create the first searchable records.'}</p></div>}
        </div>
        <footer className="vc-pagination"><span>{data?.database.matched_records.toLocaleString() || 0} matching · showing {data?.page.returned || 0}</span><div><button type="button" onClick={() => void loadFounders(Math.max(0, offset - 25)).catch(failure => setError(errorMessage(failure)))} disabled={offset === 0 || searching}>Previous</button><button type="button" onClick={() => void loadFounders(offset + 25).catch(failure => setError(errorMessage(failure)))} disabled={!data || offset + data.page.returned >= data.database.matched_records || searching}>Next</button></div></footer>
        <p className="vc-disclosure">{data?.limitations?.[0] || 'SEC related-person filings are public leads; only a filed title or role that says founder/co-founder is labeled as a founder. No personal contact details are included.'}</p>
      </section>
    </section>
  </main>;
}
