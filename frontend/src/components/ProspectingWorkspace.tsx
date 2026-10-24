'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { request } from '../lib/api';
import { CYPHER_VOICE_INTRO } from '../lib/cypher-voice';
import BinaryLens from './cipher/BinaryLens';
import CypherMark from './cipher/CypherMark';
import WorkflowShell from './WorkflowShell';
import './prospecting-workspace.css';

type Draft = { subject: string; body: string; status: 'local_draft'; recipient: null; review_required: boolean; source_urls: string[] };
type VoiceState = 'checking' | 'setup' | 'ready' | 'loading' | 'playing' | 'error';
type Candidate = {
  id: string;
  name: string;
  source_url: string;
  retrieved_at: string;
  observed: { description: string; source: string; organization_status: string };
  inferred: { fit_score: number; matched_terms: string[]; reason: string };
  contact: { status: string; email: string | null; source_url?: string | null };
  draft: Draft | null;
};
type RunEvent = { type: string; at: string; code?: string; source?: string; source_url?: string; count?: number; result_id?: string; credits_consumed?: number | null; credits_unknown?: boolean };
type Run = {
  id: string;
  market: string;
  product: string;
  limit: number;
  status: string;
  source?: string;
  credits_consumed?: number | null;
  results: Candidate[];
  events: RunEvent[];
  gmail: { status: string; supported_draft?: boolean; detail?: string };
  limitations: string[];
};
type Profile = { url: string; title: string; description: string; market: string; product: string; assumptions: string[]; retrieved_at: string };

const terminal = (status: string) => ['completed', 'partial', 'failed', 'cancelled'].includes(status);
const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued', running: 'Researching public sources', completed: 'Research complete',
  partial: 'Partial results', failed: 'Research stopped', cancel_requested: 'Stopping…', cancelled: 'Cancelled',
};
const EVENT_LABELS: Record<string, string> = {
  queued: 'Research queued', started: 'Source research started', discovered: 'Source candidates found',
  result_saved: 'Company candidate saved', candidate_skipped: 'Candidate skipped', completed: 'Research completed',
  source_error: 'Research source returned an error', akta_request_started: 'Akta list request started',
  akta_results_saved: 'Akta company records saved', cancel_requested: 'Stop requested', cancelled: 'Research cancelled', draft_prepared: 'App draft saved',
};
const statusLabel = (status: string) => STATUS_LABELS[status] || status.replace(/_/g, ' ');
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const localTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function ProspectingWorkspace() {
  const [url, setUrl] = useState('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [manual, setManual] = useState(false);
  const [market, setMarket] = useState('');
  const [product, setProduct] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [aktaAvailable, setAktaAvailable] = useState(false);
  const [useAkta, setUseAkta] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const [voiceState, setVoiceState] = useState<VoiceState>('checking');
  const [voiceError, setVoiceError] = useState('');
  const [voiceLevel, setVoiceLevel] = useState(0);
  const inFlight = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const voiceAudio = useRef<HTMLAudioElement | null>(null);
  const voiceObjectUrl = useRef('');
  const voiceContext = useRef<AudioContext | null>(null);
  const voiceMeter = useRef<AnalyserNode | null>(null);
  const voiceFrame = useRef(0);
  const active = !!run && !terminal(run.status);
  const candidate = run?.results.find(item => item.id === selected) || run?.results[0];
  const runId = run?.id;

  useEffect(() => {
    let active = true;
    fetch('/api/voice', { cache: 'no-store' }).then(response => response.json()).then(data => {
      if (active) setVoiceState(data.configured ? 'ready' : 'setup');
    }).catch(() => { if (active) setVoiceState('error'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let current = true;
    request('/prospecting/settings').then((data: { akta_available?: boolean }) => {
      if (current) setAktaAvailable(data.akta_available === true);
    }).catch(() => { if (current) setAktaAvailable(false); });
    return () => { current = false; };
  }, []);

  useEffect(() => () => {
    voiceAudio.current?.pause();
    if (voiceObjectUrl.current) URL.revokeObjectURL(voiceObjectUrl.current);
    if (voiceFrame.current) cancelAnimationFrame(voiceFrame.current);
    if (voiceContext.current && voiceContext.current.state !== 'closed') void voiceContext.current.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    request('/prospecting/runs', { signal: controller.signal }).then((rows: Run[]) => {
      setHistoryError('');
      setRuns(rows);
      setRun(current => current || rows[0] || null);
    }).catch(loadError => {
      if (!controller.signal.aborted) setHistoryError(errorText(loadError));
    });
    return () => { controller.abort(); operation.current?.abort(); };
  }, [retry]);

  useEffect(() => {
    if (!runId || terminal(run?.status || '')) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setPollError('');
    async function poll() {
      try {
        const next: Run = await request(`/prospecting/runs/${encodeURIComponent(runId!)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRun(next);
        setRuns(rows => [next, ...rows.filter(row => row.id !== next.id)]);
        if (!terminal(next.status)) timer = setTimeout(poll, 2500);
      } catch (pollFailure) {
        if (!controller.signal.aborted) setPollError(errorText(pollFailure));
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runId, run?.status, retry]);

  useEffect(() => { setDraft(candidate?.draft || null); setNotice(''); }, [candidate?.id, runId]);

  async function perform(kind: string, action: (signal: AbortSignal) => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(kind); setError(''); setNotice('');
    const controller = new AbortController();
    operation.current = controller;
    try { await action(controller.signal); }
    catch (failure) { if (!controller.signal.aborted) setError(errorText(failure)); }
    finally { if (!controller.signal.aborted) setPending(''); inFlight.current = false; }
  }

  function understand(event: FormEvent) {
    event.preventDefault();
    void perform('profile', async signal => {
      const next: Profile = await request('/prospecting/profile', {
        method: 'POST', signal, body: JSON.stringify({ url: url.trim() }),
      }, 25000);
      if (signal.aborted) return;
      setProfile(next);
      setMarket(next.market || '');
      setProduct(next.product || '');
      setConfirmed(false);
      setManual(true);
    });
  }

  function start(event: FormEvent) {
    event.preventDefault();
    if (active || !confirmed || market.trim().length < 2 || product.trim().length < 2) return;
    void perform('run', async signal => {
      const next: Run = await request('/prospecting/runs', {
        method: 'POST', signal, body: JSON.stringify({ market: market.trim(), product: product.trim(), limit: 20, use_akta: useAkta }),
      });
      if (signal.aborted) return;
      setRun(next); setSelected(''); setDraft(null);
      setRuns(rows => [next, ...rows.filter(row => row.id !== next.id)]);
    });
  }

  function prepareDraft() {
    if (!run || !candidate || !terminal(run.status)) return;
    const currentRun = run, currentCandidate = candidate;
    void perform('draft', async signal => {
      const next: Draft = await request(`/prospecting/runs/${encodeURIComponent(currentRun.id)}/results/${encodeURIComponent(currentCandidate.id)}/draft`, {
        method: 'POST', signal, body: JSON.stringify({ sender_name: 'Your team' }),
      });
      if (signal.aborted) return;
      setRun(current => current?.id === currentRun.id ? {
        ...current,
        results: current.results.map(item => item.id === currentCandidate.id ? { ...item, draft: next } : item),
        events: [...current.events, { type: 'draft_prepared', at: new Date().toISOString(), result_id: currentCandidate.id }],
      } : current);
      setDraft(next);
      setNotice('App draft saved. No Gmail draft was created and nothing was sent.');
    });
  }

  function clearVoiceMeter() {
    if (voiceFrame.current) cancelAnimationFrame(voiceFrame.current);
    voiceFrame.current = 0;
    voiceMeter.current = null;
    const context = voiceContext.current;
    voiceContext.current = null;
    if (context && context.state !== 'closed') void context.close();
    setVoiceLevel(0);
  }

  function stopVoice() {
    voiceAudio.current?.pause();
    voiceAudio.current = null;
    if (voiceObjectUrl.current) URL.revokeObjectURL(voiceObjectUrl.current);
    voiceObjectUrl.current = '';
    clearVoiceMeter();
    setVoiceState('ready');
  }

  async function playVoice() {
    if (voiceState === 'playing') { stopVoice(); return; }
    if (voiceState !== 'ready' && voiceState !== 'error') return;
    setVoiceState('loading'); setVoiceError('');
    try {
      const response = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: CYPHER_VOICE_INTRO }) });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        if (response.status === 503) { setVoiceState('setup'); setVoiceError(''); return; }
        throw new Error(typeof detail.detail === 'string' ? detail.detail : 'Voice could not be generated. Try again.');
      }
      const audioUrl = URL.createObjectURL(await response.blob());
      voiceObjectUrl.current = audioUrl;
      const audio = new Audio(audioUrl);
      voiceAudio.current = audio;
      if (typeof AudioContext !== 'undefined') {
        try {
          const context = new AudioContext();
          const meter = context.createAnalyser();
          meter.fftSize = 256;
          const source = context.createMediaElementSource(audio);
          source.connect(meter);
          meter.connect(context.destination);
          voiceContext.current = context;
          voiceMeter.current = meter;
          await context.resume();
          const samples = new Uint8Array(meter.fftSize);
          let lastUiUpdate = 0;
          const animateFromAudio = (now: number) => {
            if (voiceAudio.current !== audio || voiceMeter.current !== meter) return;
            meter.getByteTimeDomainData(samples);
            let squareSum = 0;
            for (let index = 0; index < samples.length; index++) {
              const value = (samples[index] - 128) / 128;
              squareSum += value * value;
            }
            const level = Math.min(1, Math.sqrt(squareSum / samples.length) * 4.5);
            if (now - lastUiUpdate > 60) { setVoiceLevel(level); lastUiUpdate = now; }
            voiceFrame.current = requestAnimationFrame(animateFromAudio);
          };
          voiceFrame.current = requestAnimationFrame(animateFromAudio);
        } catch {
          const context = voiceContext.current;
          voiceContext.current = null;
          voiceMeter.current = null;
          if (context && context.state !== 'closed') void context.close();
        }
      }
      audio.onended = () => {
        if (voiceAudio.current !== audio) return;
        voiceAudio.current = null; URL.revokeObjectURL(audioUrl); voiceObjectUrl.current = '';
        clearVoiceMeter();
        setVoiceState('ready');
      };
      audio.onerror = () => {
        if (voiceAudio.current !== audio) return;
        voiceAudio.current = null; URL.revokeObjectURL(audioUrl); voiceObjectUrl.current = '';
        clearVoiceMeter();
        setVoiceError('The audio could not play. Try again.'); setVoiceState('error');
      };
      setVoiceState('playing');
      await audio.play();
    } catch (failure) {
      voiceAudio.current?.pause(); voiceAudio.current = null;
      if (voiceObjectUrl.current) URL.revokeObjectURL(voiceObjectUrl.current);
      voiceObjectUrl.current = '';
      clearVoiceMeter();
      setVoiceError(errorText(failure)); setVoiceState('error');
    }
  }

  function selectRun(next: Run) {
    setRun(next); setSelected(''); setDraft(null); setPollError(''); setError('');
  }

  return <WorkflowShell section="companies"><main className="cipher cx-prospecting">
    <section className="cx-hero cx-prospect-hero">
      <BinaryLens className="cx-lens" active={pending === 'profile' || active || voiceState === 'loading' || voiceState === 'playing'} level={voiceLevel} label="Cypher lens"/>
      <h1>Find your next customers</h1>
      <p>Start with your website. Refine who you want to reach. Research real companies with public evidence.</p>
      <div className="cx-voice-control">
        <button type="button" className={`cx-voice-button is-${voiceState}`} onClick={() => void playVoice()} disabled={voiceState === 'checking' || voiceState === 'setup' || voiceState === 'loading'} aria-pressed={voiceState === 'playing'}>
          <CypherMark className="cx-voice-mark" decorative level={voiceLevel}/>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 9v6h3.7l4.8 4V5l-4.8 4H4.5z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11"/></svg>
          {voiceState === 'checking' ? 'Checking voice…' : voiceState === 'setup' ? 'Voice setup needed' : voiceState === 'loading' ? 'Preparing voice…' : voiceState === 'playing' ? 'Stop voice' : voiceState === 'error' ? 'Try voice again' : 'Listen to the welcome'}
        </button>
        {voiceState === 'setup' ? <span className="cx-voice-note" role="status">Add your ElevenLabs API key in Vercel to enable this.</span> : null}
        {voiceError ? <span className="cx-voice-note" role="status">{voiceError}</span> : null}
      </div>
      <form className="cx-command" onSubmit={understand}>
        <div className="cx-group">
          <label className="cx-field" htmlFor="prospecting-url"><span>Company site</span><input id="prospecting-url" type="url" required maxLength={2048} placeholder="https://yourcompany.com" value={url} onChange={event => { setUrl(event.target.value); setProfile(null); setConfirmed(false); }} disabled={!!pending}/></label>
          <button type="submit" className="cx-run" disabled={!!pending}>{pending === 'profile' ? <><span className="cx-spinner" aria-hidden="true"/>Reading site…</> : <>Read company site<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></>}</button>
        </div>
        <small className="cx-helper">Reads public HTTPS pages that allow automated access. Your extracted offer stays editable before research.</small>
      </form>
      {error && <div role="alert" className="cx-error">{error}{/sign in|session/i.test(error) ? <> <a href="/login">Sign in</a></> : null}</div>}
    </section>

    <section className="cx-prospect-flow" aria-label="Prospecting workflow">
      <div className={`cx-step ${profile || manual ? 'is-current' : ''} ${profile ? 'is-done' : ''}`}><span>01</span><div><strong>Understand the offer</strong><small>Read your public website</small></div></div>
      <span className="cx-step-line" aria-hidden="true"/>
      <div className={`cx-step ${profile && confirmed ? 'is-current' : ''} ${run ? 'is-done' : ''}`}><span>02</span><div><strong>Review the customer profile</strong><small>Edit it before discovery</small></div></div>
      <span className="cx-step-line" aria-hidden="true"/>
      <div className={`cx-step ${run ? 'is-current' : ''}`}><span>03</span><div><strong>Research companies</strong><small>Sources and activity stay visible</small></div></div>
    </section>

    {(profile || manual) && <section className="cx-profile-panel" aria-labelledby="profile-heading">
      <div className="cx-section-heading"><div><h2 id="profile-heading">Your customer profile</h2></div>{profile && <a href={profile.url} target="_blank" rel="noopener noreferrer">View website source</a>}</div>
      {profile && <div className="cx-source-note"><span className="cx-source-dot"/>Website copy read from <a href={profile.url} target="_blank" rel="noopener noreferrer">{profile.title || profile.url}</a><span>· {new Date(profile.retrieved_at).toLocaleString()}</span></div>}
      {profile?.assumptions.map((item, index) => <p className="cx-profile-assumption" key={index}>{item}</p>)}
      <form className="cx-profile-form" onSubmit={start}>
        <label><span>Customer market or audience</span><input value={market} maxLength={300} minLength={2} required placeholder="Who benefits from this offer? Include industry, size, or region." onChange={event => { setMarket(event.target.value); setConfirmed(false); }} disabled={!!pending}/></label>
        <label><span>What you sell</span><textarea value={product} maxLength={2000} minLength={2} required rows={4} placeholder="Describe your product and the problem it solves." onChange={event => { setProduct(event.target.value); setConfirmed(false); }} disabled={!!pending}/></label>
        <label className="cx-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={!!pending}/><span>I reviewed and edited this profile. Use it to find potential customers.</span></label>
        {aktaAvailable && <><label className="cx-akta-choice"><input type="checkbox" checked={useAkta} onChange={event => setUseAkta(event.target.checked)} disabled={!!pending}/><span><strong>Use Akta company data</strong><small>Paid list generation · up to 8 credits for 20 results. No enrichment is requested.</small></span></label><a className="cx-akta-pricing" href="https://docs.akta.pro/getting-started/pricing" target="_blank" rel="noopener noreferrer">See Akta pricing</a></>}
        <button type="submit" className="cx-run" disabled={!!pending || !confirmed || active}>{pending === 'run' ? <><span className="cx-spinner" aria-hidden="true"/>Starting research…</> : useAkta ? 'Find companies with Akta' : 'Find up to 20 company candidates'}</button>
        <small className="cx-helper">Research returns source-backed company candidates. This source does not verify customer demand, contacts, or competitor status; review each result.</small>
      </form>
    </section>}

    <section className="cx-results-area" aria-label="Research results">
      <div className="cx-board">
        <div className="cx-section-heading cx-results-heading"><div><h2>{run ? run.market : 'Your shortlist'}</h2><p className="cx-status" role="status">{run ? `${statusLabel(run.status)} · ${run.results.length} of up to ${run.limit} candidates` : 'No research yet'}</p></div>
          {active && <button type="button" className="cx-secondary" disabled={!!pending || run?.status === 'cancel_requested'} onClick={() => void perform('cancel', async signal => {
            const next: Run = await request(`/prospecting/runs/${encodeURIComponent(run!.id)}/cancel`, { method: 'POST', signal });
            if (!signal.aborted) { setRun(next); setRuns(rows => [next, ...rows.filter(row => row.id !== next.id)]); setRetry(value => value + 1); }
          })}>{pending === 'cancel' || run?.status === 'cancel_requested' ? 'Stopping…' : 'Stop research'}</button>}
        </div>
        {pollError && <div role="alert" className="cx-error cx-poll-error">{pollError}<button type="button" className="cx-inline-button" disabled={!!pending} onClick={() => setRetry(value => value + 1)}>Retry status check</button></div>}
        {historyError && <div role="alert" className="cx-error cx-history-error"><span>{historyError}</span><div><button type="button" className="cx-inline-button" disabled={!!pending} onClick={() => setRetry(value => value + 1)}>Retry</button><a href={/sign in|session/i.test(historyError) ? '/login' : '/workspace'}>{/sign in|session/i.test(historyError) ? 'Sign in' : 'Workspace setup'}</a></div></div>}
        {run && <div className="cx-truth-note"><strong>Company candidates, not verified customers.</strong><span>Relevance uses text overlap. Demand, contacts, and competitor status need separate verification.</span></div>}
        {!run ? <div className="cx-empty"><BinaryLens className="cx-empty-lens" cols={21} rows={9} label="Cypher lens"/><h3>A better shortlist starts with context.</h3><p>Enter your company website above, then edit the customer profile before research.</p></div> : null}
        {run && !run.results.length && <div className="cx-empty cx-empty-compact"><div className={active ? 'cx-loading-pulse' : 'cx-empty-dot'} aria-hidden="true"/><h3>{active ? 'Checking public company descriptions…' : 'No qualifying company candidates.'}</h3><p>{active ? 'Verified results appear here as the backend saves them.' : 'Try a more specific customer market or adjust your offer. Public source coverage is limited.'}</p></div>}
        {!!run?.results.length && <>
          <div className="cx-result-list" role="list" aria-label="Company candidates">
            {run.results.map((item, index) => <button type="button" role="listitem" key={item.id} className={`cx-result-row ${candidate?.id === item.id ? 'is-selected' : ''}`} onClick={() => { setSelected(item.id); setDraft(item.draft); setNotice(''); }} aria-pressed={candidate?.id === item.id}>
              <span className="cx-result-number">{String(index + 1).padStart(2, '0')}</span><span className="cx-company-mark" aria-hidden="true">{item.name.charAt(0)}</span><span className="cx-company-name"><strong>{item.name}</strong><small>{item.observed.source} · retrieved {localTime(item.retrieved_at)}</small></span><span className="cx-overlap">{item.inferred.fit_score}<small>text match</small></span>
            </button>)}
          </div>
          {candidate && <article className="cx-detail-card" aria-label={`${candidate.name} research detail`}>
            <div className="cx-detail-header"><h3>{candidate.name}</h3><span className="cx-contact-status">{candidate.contact.email ? 'Public contact listed' : 'No verified contact'}</span></div>
            <div className="cx-detail-grid"><div><h4>Why it appeared</h4><p>{candidate.inferred.reason}</p><div className="cx-match-terms">{candidate.inferred.matched_terms.map(term => <span key={term}>{term}</span>)}</div></div>
              <div><h4>{candidate.observed.source === 'Akta' ? 'Akta company record' : 'Public evidence'}</h4><p className="cx-description">{candidate.observed.description || 'The source did not provide a readable company description.'}</p>{candidate.source_url ? <a className="cx-evidence-link" href={candidate.source_url} target="_blank" rel="noopener noreferrer">{candidate.observed.source === 'Akta' ? 'Visit listed company website' : `Read ${candidate.observed.source} source`}</a> : <small>Company details supplied by Akta · no public website was listed</small>}<small>Retrieved {new Date(candidate.retrieved_at).toLocaleString()}</small></div></div>
            {candidate.contact.email && candidate.contact.source_url && <p className="cx-verified-contact">Public business contact: <a href={`mailto:${candidate.contact.email}`}>{candidate.contact.email}</a> · <a href={candidate.contact.source_url} target="_blank" rel="noopener noreferrer">evidence</a></p>}
            {candidate.draft ? <div className="cx-draft-box"><div className="cx-draft-label"><strong>App draft preview · review required</strong><span>No recipient · not in Gmail</span></div><label>Subject<input value={draft?.subject || candidate.draft.subject} onChange={event => setDraft(current => current ? { ...current, subject: event.target.value } : candidate.draft)} disabled={!draft}/></label><label>Message<textarea rows={7} value={draft?.body || candidate.draft.body} onChange={event => setDraft(current => current ? { ...current, body: event.target.value } : candidate.draft)} disabled={!draft}/></label><div className="cx-draft-actions"><button type="button" className="cx-secondary" onClick={async () => { try { await navigator.clipboard.writeText(`Subject: ${draft?.subject || candidate.draft!.subject}\n\n${draft?.body || candidate.draft!.body}`); setNotice('Draft copied. No email was created or sent.'); } catch { setNotice('Clipboard access was unavailable.'); } }}>Copy draft</button><a href={`https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(draft?.subject || candidate.draft.subject)}&body=${encodeURIComponent(draft?.body || candidate.draft.body)}`} target="_blank" rel="noopener noreferrer">Open Gmail compose</a></div><p>Edits stay on this screen. Gmail compose opens with the text filled in; it is not a saved Gmail draft.</p></div> : <div className="cx-draft-cta"><div><strong>Prepare a source-aware introduction</strong><small>Saved in the app for review. No recipient or Gmail draft is created.</small></div><button type="button" className="cx-secondary" disabled={!!pending || active} onClick={prepareDraft}>{pending === 'draft' ? 'Preparing…' : 'Create app draft'}</button></div>}
            {notice && <p className="cx-notice" role="status">{notice}</p>}
          </article>}
        </>}
        {run && <details className="cx-limitations"><summary>Source and contact limitations</summary><ul>{run.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      </div>

      <aside className="cx-log" aria-label="Research activity">
        <div className="cx-log-head"><h2 className="cx-label">Activity</h2><span className={`cx-live-indicator ${active ? 'is-live' : ''}`}><i/> {active ? 'Live' : run ? statusLabel(run.status) : 'Ready'}</span></div>
        <ol>{run?.events.length ? [...run.events].reverse().map((entry, index) => <li key={`${entry.at}-${entry.type}-${index}`}>
          <time dateTime={entry.at}>{localTime(entry.at)}</time><div><strong>{EVENT_LABELS[entry.type] || entry.type.replace(/_/g, ' ')}</strong>{entry.count !== undefined && <small>{entry.count} {entry.source === 'Akta' ? 'company records' : 'public candidates'}</small>}{entry.credits_consumed !== undefined && entry.credits_consumed !== null && <small>{entry.credits_consumed} Akta credits used</small>}{entry.credits_unknown && <small>Akta may have consumed credits before this request failed.</small>}{entry.code && <small className="cx-event-code">{entry.code.replace(/_/g, ' ')}</small>}{entry.source_url && <a href={entry.source_url} target="_blank" rel="noopener noreferrer">{entry.source === 'Akta' ? 'Akta list generation docs' : 'Evidence source'}</a>}{entry.result_id && <small>Saved to this account</small>}</div>
        </li>) : <li className="cx-activity-empty"><span>{run ? 'No activity recorded yet.' : 'Research steps and source links will appear here.'}</span></li>}</ol>
        <div className="cx-provider-status"><h3>Outreach connections</h3><div><strong>Gmail</strong><span className={run?.gmail?.status === 'connection_saved' ? 'is-connected' : 'is-setup'}>{run?.gmail?.status === 'connection_saved' ? 'Connection saved · not verified' : run?.gmail?.status === 'connection_required' ? 'Needs setup' : 'Check workspace'}</span></div><p>{run?.gmail?.detail || 'Google sign-in alone does not grant mailbox access. Check the existing workspace connection before using Gmail.'}</p><div><strong>Resend</strong><span className="is-unavailable">Unavailable in this flow</span></div><p>Sending stays disabled. The app has no verified Resend sender or authorized outreach account.</p><a href="/workspace?plugins=1">Open workspace connections</a></div>
        <div className="cx-history"><div className="cx-log-head"><h2 className="cx-label">Recent research</h2></div>{runs.length === 0 ? <p>No saved runs yet.</p> : runs.slice(0, 6).map(item => <button key={item.id} type="button" className={item.id === runId ? 'is-selected' : ''} disabled={!!pending} onClick={() => selectRun(item)} aria-pressed={item.id === runId}><strong>{item.market}</strong><span>{statusLabel(item.status)} · {item.results.length} candidates</span></button>)}</div>
      </aside>
    </section>
    <footer className="cx-footer"><span>Research and drafts are saved to your workspace.</span><a href="/workspace">Open workspace</a></footer>
  </main></WorkflowShell>;
}
