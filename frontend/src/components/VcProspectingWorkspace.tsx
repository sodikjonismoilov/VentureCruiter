'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, request } from '../lib/api';
import WorkflowShell from './WorkflowShell';
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
const errorMessage = (error: unknown) => {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your sign-in expired. Sign in again to continue.';
    if (error.status === 403) return 'This workspace can’t access that research yet.';
    if (error.status === 429) return 'Cypher is handling several research requests. Try again in a moment.';
    if (error.status >= 500) return 'Cypher couldn’t reach the research service. Try again shortly.';
  }
  return 'That step didn’t finish. Please try again.';
};
const retryable = (error: unknown) => !(error instanceof ApiError) || error.status === 408 || error.status === 429 || error.status >= 500;
const dateLabel = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString() : 'Not refreshed yet';

function VcIcon({ kind }: { kind: 'back' | 'check' | 'chevron' | 'search' | 'external' }) {
  const paths = { back: 'm14 6-6 6 6 6M8 12h12', check: 'm5 12 4 4L19 6', chevron: 'm6 9 6 6 6-6', search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', external: 'M14 3h7v7m0-7L10 14M9 3H3v18h18v-6' };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>;
}

export default function VcProspectingWorkspace({ accountId }: { accountId?: string } = {}) {
  const [data, setData] = useState<FounderPage | null>(null);
  const [runs, setRuns] = useState<MatchRun[]>([]);
  const [run, setRun] = useState<MatchRun | null>(null);
  const [query, setQuery] = useState('');
  const [industry, setIndustry] = useState('');
  const [state, setState] = useState('');
  const [founderOnly, setFounderOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [direction, setDirection] = useState<MatchRun['direction']>('companies_for_thesis');
  const [oneLiner, setOneLiner] = useState('Find founders for our climate fund');
  const [thesis, setThesis] = useState('Source recent SEC Form D issuer filings across industries for venture investor research. Treat filing-named people as related persons; label someone as a founder only when a filing explicitly says founder or co-founder. Do not contact anyone or add personal contact details.');
  const [industries, setIndustries] = useState('');
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadError, setHistoryLoadError] = useState('');
  const [historyLoadRetry, setHistoryLoadRetry] = useState(0);
  const [historyPollError, setHistoryPollError] = useState('');
  const [historyPollNeedsSignIn, setHistoryPollNeedsSignIn] = useState(false);
  const [historyPollRetry, setHistoryPollRetry] = useState(0);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startingHistory, setStartingHistory] = useState(false);
  const [drafting, setDrafting] = useState('');
  const [outreach, setOutreach] = useState<{ resultId: string; value: Outreach } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [workspaceStep, setWorkspaceStep] = useState<'thesis' | 'research' | 'shortlist' | 'outreach' | 'meetings'>('research');
  const [selectedFounderId, setSelectedFounderId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'overview' | 'evidence' | 'outreach' | 'notes'>('overview');
  const [shortlistItems, setShortlistItems] = useState<Founder[]>([]);
  const shortlistKey = accountId ? `cypher-vc-shortlist:${accountId}` : null;
  const [shortlistLoadedFor, setShortlistLoadedFor] = useState<string | null>(null);
  const founderRequestSequence = useRef(0);

  useEffect(() => {
    setShortlistItems([]);
    if (!shortlistKey) { setShortlistLoadedFor(null); return; }
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(shortlistKey) || '[]');
      if (Array.isArray(stored)) setShortlistItems(stored.filter((value): value is Founder => value && typeof value === 'object' && typeof value.id === 'string' && typeof value.person_name === 'string' && typeof value.company_name === 'string' && Array.isArray(value.roles) && value.location && typeof value.location === 'object' && typeof value.source_url === 'string'));
    } catch { /* Keep this account's shortlist empty when local storage is unavailable. */ }
    setShortlistLoadedFor(shortlistKey);
  }, [shortlistKey]);

  useEffect(() => {
    if (shortlistKey && shortlistLoadedFor === shortlistKey) {
      try { window.localStorage.setItem(shortlistKey, JSON.stringify(shortlistItems)); } catch { /* The current tab still keeps the shortlist usable. */ }
    }
  }, [shortlistItems, shortlistLoadedFor, shortlistKey]);

  useEffect(() => {
    const available = [...(data?.items || []), ...shortlistItems];
    if (available.length && !available.some(item => item.id === selectedFounderId)) {
      setSelectedFounderId(available[0].id);
    }
  }, [data, shortlistItems, selectedFounderId]);

  const loadFounders = useCallback(async (nextOffset: number, signal?: AbortSignal) => {
    const sequence = ++founderRequestSequence.current;
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (industry.trim()) params.set('industry', industry.trim());
    if (state.trim()) params.set('state', state.trim());
    if (founderOnly) params.set('founder_only', 'true');
    params.set('limit', '25');
    params.set('offset', String(nextOffset));
    let next: FounderPage;
    try { next = await request(`/prospecting/investors/founders?${params.toString()}`, { signal }); }
    catch (failure) { if (signal?.aborted || sequence !== founderRequestSequence.current) return null; throw failure; }
    if (!signal?.aborted && sequence === founderRequestSequence.current) {
      setData(next);
      setOffset(nextOffset);
    }
    return next;
  }, [founderOnly, industry, query, state]);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    const rows: MatchRun[] = await request('/prospecting/investors/runs', { signal });
    if (!signal?.aborted) {
      setRuns(rows);
      setRun(current => current || rows[0] || null);
    }
    return rows;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++founderRequestSequence.current;
    setLoading(true);
    const params = new URLSearchParams({ limit: '25', offset: '0' });
    request(`/prospecting/investors/founders?${params.toString()}`, { signal: controller.signal })
      .then((next: FounderPage) => { if (!controller.signal.aborted && sequence === founderRequestSequence.current) setData(next); })
      .catch(failure => { if (!controller.signal.aborted && sequence === founderRequestSequence.current) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []); // Initial SEC data load only; searches are submitted explicitly.

  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoading(true);
    setHistoryLoadError('');
    loadRuns(controller.signal)
      .catch(failure => { if (!controller.signal.aborted) setHistoryLoadError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [historyLoadRetry, loadRuns]);

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
    setHistoryPollError('');
    setHistoryPollNeedsSignIn(false);
    const poll = async () => {
      try {
        const next: FounderHistory = await request('/prospecting/investors/founders/backfill', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setHistoryPollError('');
        setHistoryPollNeedsSignIn(false);
        setData(current => current ? { ...current, database: { ...current.database, historical: next } } : current);
        if (['pending', 'running'].includes(next.status)) timer = setTimeout(poll, 5000);
        else if (next.status === 'completed') {
          try {
            await loadFounders(0, controller.signal);
            if (!controller.signal.aborted) setNotice('Historical SEC Form D archive is indexed and searchable.');
          } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
        } else if (next.error) setError(next.error);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setHistoryPollError(errorMessage(failure));
          setHistoryPollNeedsSignIn(failure instanceof ApiError && failure.status === 401);
          if (retryable(failure)) timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [data?.database.historical.status, historyPollRetry, loadFounders]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (loading || searching) return;
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
  const steps = [
    { id: 'thesis', label: 'Thesis' },
    { id: 'research', label: 'Research' },
    { id: 'shortlist', label: 'Shortlist' },
    { id: 'outreach', label: 'Outreach' },
    { id: 'meetings', label: 'Meetings' },
  ] as const;
  const savedListView = workspaceStep === 'shortlist';
  const visibleFounders = workspaceStep === 'shortlist' ? shortlistItems : (data?.items || []);
  const selectedFounder = [...(data?.items || []), ...shortlistItems].find(item => item.id === selectedFounderId) || visibleFounders[0] || null;
  const isShortlisted = (id: string) => shortlistItems.some(item => item.id === id);
  const toggleShortlist = (item: Founder) => setShortlistItems(rows => rows.some(row => row.id === item.id) ? rows.filter(row => row.id !== item.id) : [item, ...rows]);
  const currentDraftReady = !!outreach;
  const runStatus = !run ? historyLoading ? 'Loading saved research' : 'No match yet' : activeRun ? 'Researching' : run.status === 'completed' ? 'Ready to review' : run.status === 'partial' ? 'Some results ready' : run.status === 'failed' ? 'Needs another try' : 'Stopped';

  return <WorkflowShell section="investors"><main className="vc-page">
    <header className="vc-titlebar">
      <a className="vc-back" href="/prospecting" aria-label="Back to company research"><VcIcon kind="back"/></a>
      <div><h1>{oneLiner || 'Find founders for your climate fund'}</h1><p>Research founders and companies with public SEC evidence.</p></div>
      <span className="vc-title-status"><i aria-hidden="true" />{data?.database.snapshot_ready ? 'Public data connected' : 'Ready to find public data'}</span>
    </header>

    <nav className="vc-steps" aria-label="Founder research steps">
      {steps.map((step, index) => <button type="button" key={step.id} className={workspaceStep === step.id ? 'is-current' : ''} aria-current={workspaceStep === step.id ? 'step' : undefined} onClick={() => setWorkspaceStep(step.id)}>
        <span className="vc-step-number">{index + 1}</span><span>{step.label}</span>
      </button>)}
    </nav>

    {error ? <div className="vc-alert" role="alert"><span aria-hidden="true">!</span><div><strong>We couldn’t finish that step.</strong><p>{error}</p><button type="button" onClick={() => setError('')}>Dismiss</button></div></div> : null}
    {historyLoadError ? <div className="vc-alert" role="alert"><span aria-hidden="true">!</span><div><strong>Saved match history couldn’t load.</strong><p>{historyLoadError}</p>{historyLoadError.includes('sign-in expired') ? <a href="/login">Sign in again</a> : <button type="button" onClick={() => setHistoryLoadRetry(value => value + 1)}>Retry saved history</button>}</div></div> : null}
    {notice ? <div className="vc-notice" role="status"><VcIcon kind="check"/>{notice}</div> : null}

    <section className="vc-data-settings">
      <details>
        <summary><span className="vc-source-dot" />SEC public data and coverage <small>{loading ? 'Checking data…' : (data?.database.records ?? 0).toLocaleString() + ' people and company records'}</small><span className="vc-summary-chevron"><VcIcon kind="chevron"/></span></summary>
        <div className="vc-data-settings-body">
          <p>Cypher uses public SEC Form D filings. A person is labeled a founder only when the filing explicitly says founder or co-founder.</p>
          <div className="vc-data-facts"><span><b>{(data?.database.explicit_founder_signals ?? 0).toLocaleString()}</b> filed founder signals</span><span><b>{data?.database.quarter_count ?? 0}</b> SEC quarters indexed</span><span>Last updated <b>{dateLabel(data?.database.snapshot_built_at)}</b></span></div>
          {data?.database.historical.status === 'running' || data?.database.historical.status === 'pending' ? <p className="vc-history-progress">{data.database.historical.processed_quarters.toLocaleString()} of {data.database.historical.total_quarters.toLocaleString()} historical quarters indexed{data.database.historical.current_quarter ? ' · working on ' + data.database.historical.current_quarter.toUpperCase() : ''}</p> : null}
          {historyPollError ? <p className="vc-inline-error" role="alert">{historyPollError} {historyPollNeedsSignIn ? <a href="/login">Sign in again</a> : <button type="button" onClick={() => setHistoryPollRetry(value => value + 1)}>Retry status check</button>}</p> : null}
          {data?.database.historical.status === 'failed' ? <p className="vc-inline-error">The archive import paused. You can safely resume it.</p> : null}
          <div className="vc-data-actions">
            <button type="button" onClick={() => void startSecRefresh()} disabled={starting || activeRun}>{starting ? 'Starting…' : data?.database.snapshot_ready ? 'Refresh recent SEC data' : 'Get recent SEC data'}</button>
            <button type="button" onClick={() => void startHistoricalImport()} disabled={startingHistory || ['pending', 'running'].includes(data?.database.historical.status || 'idle')}>{startingHistory ? 'Starting…' : data?.database.historical.status === 'completed' ? 'Check SEC archive' : data?.database.historical.status === 'failed' ? 'Resume archive import' : 'Add SEC history from 2008'}</button>
          </div>
        </div>
      </details>
    </section>

    {workspaceStep === 'thesis' ? <section className="vc-thesis-card">
      <div className="vc-section-intro"><h2>What are you looking to invest in?</h2><p>Describe it the way you’d explain it to a colleague. Cypher will use this to find relevant public company and fund information.</p></div>
      <form className="vc-thesis-form" onSubmit={startMatch}>
        <label>Give this search a name<input value={oneLiner} onChange={event => setOneLiner(event.target.value)} minLength={4} maxLength={300} required placeholder="e.g. Climate founders at seed stage" /></label>
        <label>Describe what makes a good fit<textarea value={thesis} onChange={event => setThesis(event.target.value)} minLength={20} maxLength={4000} rows={5} required placeholder="Include the stage, location, and themes you care about." /></label>
        <label>Industries to focus on <span>Optional</span><input value={industries} onChange={event => setIndustries(event.target.value)} placeholder="Climate, energy, agriculture" /></label>
        <label>What should Cypher find?<select value={direction} onChange={event => setDirection(event.target.value as MatchRun['direction'])}><option value="companies_for_thesis">Companies that fit my fund</option><option value="investors_for_thesis">Investors for a company</option></select></label>
        <button className="vc-primary" type="submit" disabled={starting || activeRun || oneLiner.trim().length < 4 || thesis.trim().length < 20}>{starting ? 'Starting research…' : activeRun ? 'Research is already running' : 'Find matching companies'}</button>
      </form>
      <p className="vc-footnote">Cypher reviews public sources. You can check every source before taking action.</p>
    </section> : null}

    {workspaceStep === 'research' || workspaceStep === 'shortlist' ? <div className="vc-dashboard-grid">
      <section className="vc-candidates-panel" aria-labelledby="vc-candidates-title">
        <header className="vc-candidates-heading">
          <div><h2 id="vc-candidates-title">{workspaceStep === 'shortlist' ? 'Your shortlist' : 'Founder and company research'}</h2><p>{workspaceStep === 'shortlist' ? (shortlistKey ? 'Saved on this device for your account.' : 'Kept in this tab. Sign in to save a shortlist on this device.') : 'Search people named in company filings. Every result links to its public source.'}</p></div>
          <button className="vc-reload" type="button" onClick={() => void loadFounders(0).catch(failure => setError(errorMessage(failure)))} disabled={loading || searching}>Refresh</button>
        </header>

        {workspaceStep === 'research' ? <>
          <div className="vc-stats" aria-label="Research totals">
            <div><strong>{loading ? '—' : (data?.database.records ?? 0).toLocaleString()}</strong><span>People in SEC index</span></div>
            <div><strong>{loading ? '—' : (data?.database.explicit_founder_signals ?? 0).toLocaleString()}</strong><span>Filed founder signals</span></div>
            <div><strong>{run?.results?.length ?? 0}</strong><span>Company matches</span></div>
            <div><strong>{shortlistItems.length}</strong><span>Shortlisted</span></div>
          </div>
          <form className="vc-search" onSubmit={search}>
            <label className="vc-search-query"><span className="vc-sr-only">Search founders</span><VcIcon kind="search"/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search people, companies, or roles…" /></label>
            <details className="vc-more-filters"><summary>Filters</summary><div>
              <label>Industry<input value={industry} onChange={event => setIndustry(event.target.value)} placeholder="Any industry" /></label>
              <label>State<input value={state} onChange={event => setState(event.target.value)} placeholder="Any state" maxLength={80} /></label>
              <label className="vc-checkbox"><input type="checkbox" checked={founderOnly} onChange={event => setFounderOnly(event.target.checked)} /> Founder titles only</label>
            </div></details>
            <button className="vc-search-button" type="submit" disabled={searching || loading}>{searching ? 'Searching…' : 'Search'}</button>
          </form>
        </> : null}

        <div className="vc-table-head"><h3>{savedListView ? 'Saved candidates' : 'Candidates (' + (data?.database.matched_records ?? 0).toLocaleString() + ')'}</h3><span>Source-backed records</span></div>
        <div className="vc-table-wrap">
          <table className="vc-candidate-table">
            <thead><tr><th scope="col">Company</th><th scope="col">Founder or related person</th><th scope="col">Filed role</th><th scope="col">Evidence</th></tr></thead>
            <tbody>
              {loading && workspaceStep === 'research' ? <tr><td colSpan={4} className="vc-table-message">Loading public filing records…</td></tr> : visibleFounders.length ? visibleFounders.map(item => {
                const founderSignal = item.founder_status === 'founder_named_in_filing';
                return <tr key={item.id} className={selectedFounder?.id === item.id ? 'is-selected' : ''} aria-selected={selectedFounder?.id === item.id}>
                  <td><button className="vc-row-select" type="button" onClick={() => { setSelectedFounderId(item.id); setDetailTab('overview'); }}><strong>{item.company_name}</strong><small>{item.industry || 'Industry not listed'}</small></button></td>
                  <td><button className="vc-row-select" type="button" onClick={() => { setSelectedFounderId(item.id); setDetailTab('overview'); }}><strong>{item.person_name}</strong><small>{[item.location?.city, item.location?.state].filter(Boolean).join(', ') || 'Location not listed'}</small></button></td>
                  <td>{item.title || item.roles.join(', ') || 'Not listed'}</td>
                  <td><span className={founderSignal ? 'vc-evidence-badge is-founder' : 'vc-evidence-badge'}>{founderSignal ? 'Founder named' : 'Related person'}</span></td>
                </tr>;
              }) : <tr><td colSpan={4} className="vc-table-message"><strong>{workspaceStep === 'shortlist' ? 'Your shortlist is empty' : data?.database.snapshot_ready ? 'No matching people found' : 'The SEC index is ready to build'}</strong><span>{workspaceStep === 'shortlist' ? 'Save a person from research and they’ll show up here.' : data?.database.snapshot_ready ? 'Try another name or remove a filter.' : 'Open “SEC public data and coverage” above to load the latest filings.'}</span></td></tr>}
            </tbody>
          </table>
        </div>
        {workspaceStep === 'research' ? <footer className="vc-pagination"><span>{(data?.database.matched_records ?? 0).toLocaleString()} people found · showing {data?.page.returned ?? 0}</span><div><button type="button" onClick={() => void loadFounders(Math.max(0, offset - 25)).catch(failure => setError(errorMessage(failure)))} disabled={offset === 0 || searching}>Previous</button><button type="button" onClick={() => void loadFounders(offset + 25).catch(failure => setError(errorMessage(failure)))} disabled={!data || offset + data.page.returned >= data.database.matched_records || searching}>Next</button></div></footer> : null}
        <p className="vc-disclosure">A filing may name executives or other related people. Cypher only uses the founder label when the SEC filing explicitly says founder or co-founder.</p>
      </section>

      <aside className="vc-detail-panel" aria-label="Selected person details">
        {selectedFounder ? <>
          <div className="vc-detail-top"><span className="vc-detail-symbol" aria-hidden="true">{selectedFounder.company_name.slice(0, 1).toUpperCase()}</span></div>
          <h2>{selectedFounder.company_name}</h2><p className="vc-detail-subtitle">{selectedFounder.industry || 'Company named in an SEC filing'}</p>
          <nav className="vc-detail-tabs" aria-label="Candidate details">{(['overview', 'evidence', 'outreach', 'notes'] as const).map(tab => <button type="button" key={tab} aria-current={detailTab === tab ? 'page' : undefined} onClick={() => setDetailTab(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
          {detailTab === 'overview' ? <div className="vc-detail-content">
            <dl className="vc-facts"><div><dt>Person named</dt><dd>{selectedFounder.person_name}</dd></div><div><dt>Role in filing</dt><dd>{selectedFounder.title || selectedFounder.roles.join(', ') || 'Not specified'}</dd></div><div><dt>Location</dt><dd>{[selectedFounder.location?.city, selectedFounder.location?.state].filter(Boolean).join(', ') || 'Not listed'}</dd></div><div><dt>Filing date</dt><dd>{selectedFounder.filing_date ? dateLabel(selectedFounder.filing_date) : 'Not listed'}</dd></div></dl>
            <h3>Why this person appears</h3><p>{selectedFounder.founder_status === 'founder_named_in_filing' ? (selectedFounder.founder_evidence || 'The filing explicitly identifies a founder role.') : 'This person is named in a company filing. The filing does not explicitly identify them as a founder.'}</p>
            {selectedFounder.source_url ? <a className="vc-source-link" href={selectedFounder.source_url} target="_blank" rel="noreferrer">Open SEC filing <VcIcon kind="external"/></a> : null}
          </div> : null}
          {detailTab === 'evidence' ? <div className="vc-detail-content">
            <h3>Filing evidence</h3><p>{selectedFounder.founder_evidence || 'This filing lists the person as related to the issuer, without a founder title.'}</p>
            <dl className="vc-facts"><div><dt>Record type</dt><dd>{selectedFounder.founder_status === 'founder_named_in_filing' ? 'Founder named in filing' : 'Related person named in filing'}</dd></div><div><dt>Filings indexed</dt><dd>{selectedFounder.filing_count_in_snapshot.toLocaleString()}</dd></div><div><dt>SEC quarters</dt><dd>{selectedFounder.source_quarters.map(value => value.toUpperCase()).join(', ') || 'Latest indexed snapshot'}</dd></div></dl>
            {selectedFounder.source_url ? <a className="vc-source-link" href={selectedFounder.source_url} target="_blank" rel="noreferrer">Review original source <VcIcon kind="external"/></a> : null}
          </div> : null}
          {detailTab === 'outreach' ? <div className="vc-detail-content">
            <h3>Prepare a first conversation</h3><p>Cypher can prepare an editable email and meeting brief after it finds a company match. Nothing is sent automatically.</p>
            <button className="vc-outline-action" type="button" onClick={() => setWorkspaceStep('outreach')}>Review company matches</button>
          </div> : null}
          {detailTab === 'notes' ? <div className="vc-detail-content"><h3>Research notes</h3><p>Use the filing and its linked source to verify the person’s current role before reaching out.</p><p className="vc-muted">This record comes from public SEC data and does not include a verified email address.</p></div> : null}
          <footer className="vc-detail-actions">
            <button className="vc-primary" type="button" onClick={() => toggleShortlist(selectedFounder)}>{isShortlisted(selectedFounder.id) ? 'Remove from shortlist' : 'Add to shortlist'}</button>
            <span>{isShortlisted(selectedFounder.id) ? 'Saved on this device' : 'Your shortlist stays on this device'}</span>
          </footer>
        </> : <div className="vc-empty-detail"><h2>Choose a person to review</h2><p>Select a row to see the company and SEC evidence.</p></div>}
      </aside>
    </div> : null}

    {workspaceStep === 'outreach' ? <section className="vc-outreach-workspace">
      <header className="vc-candidates-heading"><div><h2>Company matches and outreach</h2><p>Review a match, then prepare an editable email and meeting brief. Cypher never sends it for you.</p></div><span className="vc-run-badge">{runStatus}</span></header>
      {!run?.results?.length ? <div className="vc-workflow-empty"><h3>{activeRun ? 'Cypher is researching your thesis' : 'Start with your investment focus'}</h3><p>{activeRun ? 'This page will update when the public-source research is ready.' : 'Add your thesis and run a search. Cypher will use that research to prepare a source-backed first conversation.'}</p>{!activeRun ? <button className="vc-primary" type="button" onClick={() => setWorkspaceStep('thesis')}>Set up a search</button> : <span className="vc-live-indicator"><i /> Working in the background</span>}</div> : <>
        <div className="vc-outreach-grid"><div className="vc-match-list"><div className="vc-table-head"><h3>{run.direction === 'companies_for_thesis' ? 'Companies to review' : 'Investors to review'}</h3><span>{run.results.length} results</span></div>
          {run.results.map(result => <article className="vc-match-card" key={result.id}>
            <div><strong>{result.name}</strong><p>{String(result.reason || (Array.isArray(result.reasons) ? result.reasons.join(' · ') : '') || result.industry || 'Public-source match')}</p></div>
            {typeof result.score === 'number' ? <span className="vc-fit-score">{Math.round(result.score)}% fit</span> : null}
            {result.source_url || result.sources?.[0]?.url || result.website ? <a href={String(result.source_url || result.sources?.[0]?.url || result.website)} target="_blank" rel="noreferrer">View source <VcIcon kind="external"/></a> : null}
            <button className="vc-outline-action" type="button" onClick={() => void prepareOutreach(result)} disabled={!!drafting || !terminal(run.status)}>{drafting === result.id ? 'Preparing…' : outreach?.resultId === result.id ? 'Refresh draft' : 'Prepare outreach'}</button>
          </article>)}
          {run.limitations?.length ? <p className="vc-muted">{run.limitations[0]}</p> : null}
        </div>
        <div className="vc-draft-card">
          {outreach ? <><h3>{outreach.value.subject}</h3><p className="vc-recipient">{outreach.value.recipient || 'Recipient not provided'}</p><pre>{outreach.value.body}</pre><button className="vc-outline-action" type="button" onClick={() => setWorkspaceStep('meetings')}>Open meeting brief</button></> : <div className="vc-workflow-empty"><h3>Outreach stays in your hands</h3><p>Choose a company and prepare a draft to see a researched message here. It will not be sent.</p></div>}
        </div></div>
      </>}
      {run?.events?.length ? <details className="vc-source-activity"><summary>See public source activity</summary><ul>{run.events.slice(-8).reverse().map((event, index) => <li key={event.at + event.type + index}><span>{event.type.replaceAll('_', ' ')}</span>{typeof event.count === 'number' ? <small>{event.count.toLocaleString()}</small> : null}{event.source_url ? <a href={event.source_url} target="_blank" rel="noreferrer">Source</a> : null}</li>)}</ul></details> : null}
    </section> : null}

    {workspaceStep === 'meetings' ? <section className="vc-meeting-workspace">
      <header className="vc-candidates-heading"><div><h2>Walk into the conversation prepared</h2><p>Build from public evidence and keep the draft under your review.</p></div>{outreach ? <span className="vc-run-badge">Brief ready</span> : null}</header>
      {outreach ? <div className="vc-meeting-card"><div className="vc-meeting-main"><h3>{outreach.value.meeting_brief.goal}</h3>
        {outreach.value.meeting_brief.public_signals.length ? <><h4>Public signals</h4><ul>{outreach.value.meeting_brief.public_signals.map((signal, index) => <li key={index + signal}>{signal}</li>)}</ul></> : null}
        <h4>Questions to cover</h4><ul>{outreach.value.meeting_brief.questions.map((question, index) => <li key={index + question}>{question}</li>)}</ul>
        <h4>Before you send</h4><ul>{outreach.value.meeting_brief.before_sending.map((item, index) => <li key={index + item}>{item}</li>)}</ul>
        <h4>Sources</h4><ul>{outreach.value.meeting_brief.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></li>)}</ul>
        <button className="vc-outline-action" type="button" onClick={() => setWorkspaceStep('outreach')}>Back to outreach draft</button>
      </div><aside className="vc-meeting-draft"><h3>{outreach.value.subject}</h3><p>{outreach.value.body}</p><small>{outreach.value.sending}</small></aside></div> : <div className="vc-workflow-empty"><h3>Your meeting brief will appear here</h3><p>Run a company search, then choose “Prepare outreach” on a match. Cypher will create a draft and a source-backed briefing.</p><button className="vc-primary" type="button" onClick={() => setWorkspaceStep(run?.results?.length ? 'outreach' : 'thesis')}>{run?.results?.length ? 'Review company matches' : 'Set up a search'}</button></div>}
    </section> : null}

    {run ? <p className="vc-run-footnote" aria-live="polite"><span className={activeRun ? 'vc-live-indicator' : ''}>{activeRun ? <><i /> Research in progress</> : runStatus}</span><span>{run.thesis?.one_liner || oneLiner}</span></p> : null}
  </main></WorkflowShell>;
}
