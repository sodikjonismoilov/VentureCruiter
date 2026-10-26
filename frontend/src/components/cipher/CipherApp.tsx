'use client';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { MARKETS, PERSONAS, type Company } from '../../lib/cipher/markets';
import BinaryLens from './BinaryLens';
import ProspectBrain from './ProspectBrain';
import CipherIntro from './CipherIntro';
import { GREETING, SUGGESTIONS, localReply } from '../../lib/cipher/assistant';
import { SIGNAL_MAX, accountIntel, leadsToCsv, type Lead, type RunEvent, type SignalKind, type Stage } from '../../lib/cipher/engine';

type Step = Extract<RunEvent, { type: 'step' }>;
type View = 'brain' | 'accounts' | 'pipeline';
type Tier = Lead['tier'];
const STORE = 'cipher-territory-v2';
const KEY_STORE = 'cipher-openrouter-key';
const shortModel = (id: string) => id.split('/').pop() || id;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
type ChatMsg = { role: 'user' | 'assistant'; text: string; tickers?: string[]; via?: string; typing?: boolean };
const KINDS: { id: SignalKind; label: string }[] = [
  { id: 'hiring', label: 'Hiring' }, { id: 'raising', label: 'Raising' }, { id: 'spending', label: 'Spending' }, { id: 'news', label: 'Momentum' },
];
const STAGES: { id: Stage; label: string }[] = [
  { id: 'drafted', label: 'Ready to send' }, { id: 'sent', label: 'Sent' }, { id: 'replied', label: 'Replied' }, { id: 'meeting', label: 'Meeting booked' },
];
const stageLabel = (stage: Stage) => STAGES.find(s => s.id === stage)?.label ?? 'Queued';
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function load<T>(fallback: T): T { try { const v = localStorage.getItem(STORE); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } }
function save(value: unknown) { try { localStorage.setItem(STORE, JSON.stringify(value)); } catch {} }

export default function CipherApp() {
  const [marketId, setMarketId] = useState(MARKETS[0].id);
  const [offering, setOffering] = useState('AI-driven outbound that books qualified meetings');
  const [persona, setPersona] = useState<string>(PERSONAS[0]);
  const [senderName, setSenderName] = useState('');
  const [tickers, setTickers] = useState('');
  const [webhook, setWebhook] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [scanning, setScanning] = useState<string[]>([]);
  const [finishedAt, setFinishedAt] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>('brain');
  const [filter, setFilter] = useState<'All' | Tier>('All');
  const [toast, setToast] = useState('');
  const [orKey, setOrKey] = useState('');
  const [serverAi, setServerAi] = useState(false);
  const [aiBusy, setAiBusy] = useState<string[]>([]);
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const dispatchInFlight = useRef(false);
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState<ChatMsg[]>([{ role: 'assistant', text: GREETING }]);
  const threadRef = useRef<HTMLOListElement>(null);
  const [asking, setAsking] = useState(false);
  const leadsRef = useRef<Lead[]>([]);
  const researchGen = useRef(0);
  const researching = useRef(false);
  leadsRef.current = leads;
  const logRef = useRef<HTMLOListElement>(null);
  const ready = useRef(false);

  useEffect(() => {
    const s = load<null | Record<string, unknown>>(null);
    if (s) {
      if (typeof s.marketId === 'string') setMarketId(s.marketId);
      if (typeof s.offering === 'string') setOffering(s.offering);
      if (typeof s.persona === 'string') setPersona(s.persona);
      if (typeof s.senderName === 'string') setSenderName(s.senderName);
      if (typeof s.tickers === 'string') setTickers(s.tickers);
      if (typeof s.webhook === 'string') setWebhook(s.webhook);
      if (Array.isArray(s.leads)) setLeads(s.leads as Lead[]);
      if (Array.isArray(s.steps)) setSteps(s.steps as Step[]);
      if (typeof s.finishedAt === 'string') setFinishedAt(s.finishedAt);
    }
    try { setOrKey(localStorage.getItem(KEY_STORE) || ''); } catch {}
    fetch('/api/cipher/ai').then(r => r.json()).then((d: { serverKey?: boolean }) => setServerAi(Boolean(d.serverKey))).catch(() => {});
    ready.current = true;
  }, []);
  useEffect(() => { if (!ready.current) return; try { if (orKey.trim()) localStorage.setItem(KEY_STORE, orKey.trim()); else localStorage.removeItem(KEY_STORE); } catch {} }, [orKey]);
  useEffect(() => { if (ready.current && !running) save({ marketId, offering, persona, senderName, tickers, webhook, leads, steps: steps.slice(-300), finishedAt }); }, [marketId, offering, persona, senderName, tickers, webhook, leads, steps, finishedAt, running]);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [steps.length]);
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [chat]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2800); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { if (!selected) return; const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); }; window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc); }, [selected]);

  const market = MARKETS.find(m => m.id === marketId) ?? MARKETS[0];
  const customTickers = tickers.split(/[\s,]+/).map(t => t.trim().toUpperCase()).filter(t => /^[A-Z.]{1,6}$/.test(t)).slice(0, 20);
  const territory: Company[] = useMemo(() => {
    if (!customTickers.length) return market.companies;
    const known = new Map(MARKETS.flatMap(m => m.companies).map(c => [c.ticker, c]));
    return customTickers.slice(0, 20).map(t => known.get(t) ?? { name: t, ticker: t, domain: '', hq: 'Public company', snapshot: { openRoles: 0, gtmRoles: 0, raisedRecently: false, filings90d: 0, capexTrend: 'flat' } });
  }, [market, customTickers.join()]);
  const byId = useMemo(() => new Map(leads.map(l => [l.id, l])), [leads]);
  const ranked = useMemo(() => [...leads].sort((a, b) => b.score - a.score), [leads]);
  const rows = leads.length || running ? ranked : [];
  const visible = filter === 'All' ? rows : rows.filter(l => l.tier === filter);
  const pending = running ? territory.filter(c => !byId.has(c.ticker)) : [];
  const lead = selected ? byId.get(selected) ?? null : null;
  const count = (t: Tier) => leads.filter(l => l.tier === t).length;
  const launched = leads.filter(l => l.stage !== 'drafted').length;
  const meetings = leads.filter(l => l.stage === 'meeting').length;
  const readyHot = leads.filter(l => l.tier === 'Hot' && l.stage === 'drafted');

  const log = (text: string, tone: Step['tone'] = 'info', ticker?: string) => setSteps(s => [...s, { type: 'step', at: new Date().toISOString(), text, tone, ticker }]);
  const aiReady = serverAi || orKey.trim().length >= 20;
  const aiHeaders = (): Record<string, string> => ({ 'Content-Type': 'application/json', ...(orKey.trim() ? { 'x-openrouter-key': orKey.trim() } : {}) });

  async function research(targets: Lead[]) {
    if (!targets.length || researching.current) return;
    if (!aiReady) { setSetupOpen(true); setToast('Add an OpenRouter key in Setup to research with AI'); return; }
    researching.current = true;
    const gen = researchGen.current; const live = () => gen === researchGen.current;
    const queue = [...targets]; let done = 0, stop = '';
    setAiProgress({ done: 0, total: targets.length });
    log(`AI research started on ${targets.length} account${targets.length > 1 ? 's' : ''}`);
    const worker = async () => {
      for (let t = queue.shift(); t && !stop && live(); t = queue.shift()) {
        const target = t; const current = leadsRef.current.find(l => l.id === target.id) ?? target;
        setAiBusy(b => [...b, target.id]);
        try {
          const res = await fetch('/api/cipher/research', { method: 'POST', headers: aiHeaders(), body: JSON.stringify({ lead: current, offering, persona, senderName }) });
          const data = await res.json().catch(() => ({})) as { lead?: Lead; model?: string; web?: boolean; detail?: string };
          if (!res.ok || !data.lead) { if (res.status === 401 || res.status === 402) stop = data.detail || 'The AI key was rejected.'; throw new Error(data.detail || `Research answered ${res.status}.`); }
          const next = data.lead;
          if (!live()) return;
          setLeads(ls => ls.map(l => (l.id === next.id ? { ...next, stage: l.stage, sentAt: l.sentAt, email: l.stage === 'drafted' ? next.email : l.email } : l)));
          log(`${next.company.name}: score ${current.score} → ${next.score} (${next.tier}) from ${shortModel(data.model || '')}${data.web ? ' with web search' : ''}. ${next.why}`, next.tier === 'Hot' ? 'good' : 'info', next.id);
        } catch (e) {
          if (live()) log(`${target.company.name}: AI research failed. ${e instanceof Error ? e.message : ''}`, 'warn', target.id);
        } finally {
          done++; if (live()) setAiProgress({ done, total: targets.length }); setAiBusy(b => b.filter(id => id !== target.id));
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (!live()) return;
    researching.current = false; setAiProgress(null);
    if (stop) { setToast(stop); log(stop, 'warn'); } else log(`AI research finished on ${done} account${done > 1 ? 's' : ''}`, 'good');
  }

  async function say(reply: { text: string; tickers?: string[]; via?: string }) {
    const words = reply.text.split(' ');
    for (let i = 3; i < words.length + 3; i += 3) {
      const text = words.slice(0, i).join(' ');
      setChat(c => [...c.slice(0, -1), { role: 'assistant', text, typing: i < words.length }]);
      await wait(28);
    }
    setChat(c => [...c.slice(0, -1), { role: 'assistant', text: reply.text, tickers: reply.tickers, via: reply.via }]);
  }

  async function ask(event?: FormEvent, preset?: string) {
    event?.preventDefault();
    const q = (preset ?? question).trim();
    if (!q || asking) return;
    setQuestion(''); setAsking(true);
    setChat(c => [...c, { role: 'user', text: q }, { role: 'assistant', text: '', typing: true }]);
    try {
      const local = localReply(q, leadsRef.current, { offering, persona });
      if (local) { await wait(450 + Math.random() * 350); await say(local); return; }
      if (aiReady && leadsRef.current.length) {
        try {
          const res = await fetch('/api/cipher/ask', { method: 'POST', headers: aiHeaders(), body: JSON.stringify({ question: q, offering, persona, leads: [...leadsRef.current].sort((x, y) => y.score - x.score).map(l => ({ ticker: l.id, name: l.company.name, score: l.score, tier: l.tier, stage: stageLabel(l.stage), why: l.why, signals: l.signals.map(x => `${x.kind}: ${x.headline}`) })) }) });
          const data = await res.json().catch(() => ({})) as { answer?: string; tickers?: string[]; model?: string; detail?: string };
          if (res.ok && data.answer) { await say({ text: data.answer, tickers: data.tickers ?? [], via: shortModel(data.model || '') }); log(`Asked the assistant: ${q}`); return; }
        } catch {}
      }
      await say({ text: leadsRef.current.length ? "I can't answer that one from your territory yet. Ask me who to call first, why an account is hot, who's hiring or raising, today's to-dos, or the pipeline." : "Run Outbound first and I'll rank your territory. Then ask me who to call first.", tickers: [] });
    } finally { setAsking(false); }
  }

  async function run(event?: FormEvent) {
    event?.preventDefault();
    if (running) return;
    researchGen.current++; researching.current = false; setAiProgress(null); setAiBusy([]);
    setRunning(true); setError(''); setLeads([]); setSelected(null); setFinishedAt(null); setScanning([]); if (view === 'pipeline') setView('brain');
    const got: Lead[] = []; let completed = false;
    setSteps([{ type: 'step', at: new Date().toISOString(), text: `Run started for ${customTickers.length ? 'a custom list' : market.label}` }]);
    try {
      const res = await fetch('/api/cipher/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketId, offering, persona, senderName, tickers: customTickers }) });
      if (!res.ok || !res.body) throw new Error(`The run service answered ${res.status}. Try again in a moment.`);
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as RunEvent;
          if (ev.type === 'step') { setSteps(s => [...s, ev]); if (ev.ticker && ev.text.startsWith('Scanning')) setScanning(s => [...s, ev.ticker!]); }
          else if (ev.type === 'lead') { got.push(ev.lead); setLeads(l => [...l.filter(x => x.id !== ev.lead.id), ev.lead]); }
          else { setFinishedAt(ev.at); completed = true; }
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The run stopped before finishing.';
      setError(message); log(`Run stopped: ${message}`, 'warn');
    } finally { setRunning(false); setScanning([]); }
    if (completed && got.length) {
      const hot = got.filter(l => l.tier === 'Hot').sort((a, b) => b.score - a.score);
      setChat(c => [...c, { role: 'assistant', text: `Done. I ranked ${got.length} accounts and ${hot.length} are hot${hot[0] ? `, led by ${hot[0].company.name} at ${hot[0].score}` : ''}. Want to know who to call first?`, tickers: hot.slice(0, 3).map(l => l.id) }]);
    }
    if (completed && aiReady && got.length) void research([...got].sort((a, b) => b.score - a.score));
    else if (completed && !aiReady) log('Add an OpenRouter key in Setup to have AI research every account on the live web.');
  }

  const update = (id: string, patch: Partial<Lead>) => setLeads(ls => ls.map(l => (l.id === id ? { ...l, ...patch } : l)));
  function move(l: Lead, stage: Stage) {
    update(l.id, { stage, sentAt: stage === 'sent' ? new Date().toISOString() : l.sentAt });
    log(`${l.company.name} moved to ${stageLabel(stage)}`, stage === 'meeting' ? 'good' : 'info', l.id);
  }

  async function launch(targets: Lead[]) {
    if (!targets.length || dispatchInFlight.current) return;
    dispatchInFlight.current = true;
    setDispatching(true);
    try {
      if (!webhook.trim()) {
        log('Not sent: add a sending webhook in Setup before starting a sequence.', 'warn');
        setToast('Not sent. Add a sending webhook in Setup.');
        return;
      }
      const payload = { source: 'cipher', persona, offering, leads: targets.map(l => ({ company: l.company.name, ticker: l.company.ticker, domain: l.company.domain, score: l.score, tier: l.tier, why: l.why, subject: l.email.subject, body: l.email.body, sequence: l.sequence })) };
      let detail = 'Your sending tool could not be reached.';
      try {
        const res = await fetch('/api/cipher/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhook: webhook.trim(), payload }) });
        const data = await res.json().catch(() => ({})) as { ok?: boolean; detail?: string };
        if (!res.ok || !data.ok) { detail = data.detail || detail; throw new Error(detail); }
        log(`Sent ${targets.length} sequence${targets.length > 1 ? 's' : ''} to your sending tool`, 'good');
      } catch {
        log(`Not sent: ${detail} Check the webhook in Setup.`, 'warn');
        setToast('Not sent. Check the webhook in Setup.'); return;
      }
      const now = new Date().toISOString();
      setLeads(ls => ls.map(l => (targets.some(t => t.id === l.id) ? { ...l, stage: 'sent', sentAt: now } : l)));
      setToast(`${targets.length} sequence${targets.length > 1 ? 's' : ''} started`);
    } finally {
      dispatchInFlight.current = false;
      setDispatching(false);
    }
  }

  function exportCsv() {
    const url = URL.createObjectURL(new Blob([leadsToCsv(ranked)], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `cipher-${marketId}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
    log(`Exported ${ranked.length} accounts to CSV`);
  }

  async function copyEmail(l: Lead) {
    try { await navigator.clipboard.writeText(`Subject: ${l.email.subject}\n\n${l.email.body}`); setToast('Email copied'); }
    catch { setToast('Copy blocked. Select the text in the draft instead.'); }
  }

  const status = running ? `Scanning ${leads.length} of ${territory.length}` : finishedAt ? `Last run ${new Date(finishedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : `${territory.length} accounts queued`;

  return (
    <div className="cipher">
      <CipherIntro />
      <header className="cx-toolbar">
        <a className="cx-word" href="/"><span aria-hidden="true"><BinaryLens className="cx-mark" cols={15} rows={7} /></span>Cypher</a>
        <nav className="cx-nav" aria-label="Cypher">
          <button type="button" onClick={() => setSetupOpen(v => !v)} aria-expanded={setupOpen} aria-controls="cx-setup">Setup</button>
          <button type="button" onClick={exportCsv} disabled={!leads.length}>Export CSV</button>
          <a href="/?workspace=1">Workspace</a>
        </nav>
      </header>

      <section className="cx-hero">
        <BinaryLens className="cx-lens" active={running} label="Cypher" />
        <h1>Cypher</h1>
        <form className="cx-command" onSubmit={run}>
          <div className="cx-segmented" role="radiogroup" aria-label="Territory">
            {MARKETS.map(m => (
              <label key={m.id} className={m.id === marketId && !customTickers.length ? 'on' : ''}>
                <input type="radio" name="territory" value={m.id} checked={m.id === marketId && !customTickers.length} disabled={running} onChange={() => { setMarketId(m.id); setTickers(''); }} />
                <span><span className="full">{m.label}</span><span className="short">{m.short}</span></span>
              </label>
            ))}
          </div>
          <div className="cx-group">
            <label className="cx-field" htmlFor="cx-offer"><span>You sell</span><input id="cx-offer" value={offering} onChange={e => setOffering(e.target.value)} disabled={running} required /></label>
            <label className="cx-field" htmlFor="cx-persona"><span>Buyer</span><select id="cx-persona" value={persona} onChange={e => setPersona(e.target.value)} disabled={running}>{PERSONAS.map(p => <option key={p}>{p}</option>)}</select></label>
          </div>
          {setupOpen ? (
            <div className="cx-group" id="cx-setup">
              <label className="cx-field" htmlFor="cx-sender"><span>Sign as</span><input id="cx-sender" value={senderName} placeholder="Alex, Cypher" onChange={e => setSenderName(e.target.value)} /></label>
              <label className="cx-field" htmlFor="cx-tickers"><span>Own list</span><input id="cx-tickers" value={tickers} placeholder="Tickers, e.g. HOOD, SOFI, NET" onChange={e => setTickers(e.target.value)} disabled={running} /></label>
              <label className="cx-field" htmlFor="cx-orkey"><span>AI key</span><input id="cx-orkey" type="password" autoComplete="off" spellCheck={false} value={orKey} placeholder={serverAi ? 'Using the server model gateway (optional OpenRouter key)' : 'OpenRouter key, kept in this browser'} onChange={e => setOrKey(e.target.value)} /></label>
              <label className="cx-field" htmlFor="cx-hook"><span>Send via</span><input id="cx-hook" type="url" value={webhook} placeholder="Webhook from Zapier, Make, Clay or Base44" onChange={e => setWebhook(e.target.value)} /></label>
            </div>
          ) : null}
          <button className="cx-run" type="submit" disabled={running || dispatching || !offering.trim()}>{running ? 'Running…' : 'Run Outbound'}</button>
          <div className="cx-progress">
            <div className="cx-track" aria-hidden="true"><span style={{ '--cx-progress': `${territory.length ? leads.length / territory.length : 0}` } as CSSProperties} /></div>
            <span className={running ? 'cx-status live' : 'cx-status'} role="status">{running ? status : ''}</span>
          </div>
        </form>
      </section>

      {error ? <p className="cx-error" role="alert">{error}</p> : null}

      <main className="cx-desk">
        <section className="cx-board" aria-label="Accounts">
          <div className="cx-board-head">
            <div className="cx-tabs" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === 'brain'} onClick={() => setView('brain')}>Brain</button>
              <button type="button" role="tab" aria-selected={view === 'accounts'} onClick={() => setView('accounts')}>Accounts</button>
              <button type="button" role="tab" aria-selected={view === 'pipeline'} onClick={() => setView('pipeline')}>Pipeline</button>
            </div>
            <dl className="cx-stats">
              <div><dt>Hot</dt><dd>{count('Hot')}</dd></div>
              <div><dt>Warm</dt><dd>{count('Warm')}</dd></div>
              <div><dt>Signals</dt><dd>{leads.reduce((n, l) => n + l.signals.length, 0)}</dd></div>
              <div><dt>Sent</dt><dd>{launched}</dd></div>
              <div><dt>Meetings</dt><dd>{meetings}</dd></div>
            </dl>
          </div>

          {view !== 'pipeline' ? (
            <>
              <div className="cx-tools">
                <div className="cx-filter" role="group" aria-label="Filter by tier">
                  {(['All', 'Hot', 'Warm', 'Watch'] as const).map(f => <button type="button" key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}
                </div>
                <div className="cx-tools-right">
                  <button type="button" className="cx-btn cx-ai-btn" disabled={running || !!aiProgress || dispatching || !leads.length} onClick={() => void research(ranked)}>
                    {aiProgress ? `Researching ${aiProgress.done}/${aiProgress.total}…` : 'Research with AI'}
                  </button>
                  <button type="button" className="cx-act" disabled={running || dispatching || !readyHot.length} onClick={() => void launch(readyHot)}>
                    {dispatching ? 'Starting sequence…' : readyHot.length ? `Start ${readyHot.length} hot sequence${readyHot.length > 1 ? 's' : ''}` : count('Hot') ? 'Hot sequences started' : 'Start hot sequences'}
                  </button>
                </div>
              </div>
              {view === 'brain' ? (
                <>
                  <ProspectBrain leads={leads} running={running} selected={selected} filter={filter} onSelect={setSelected} highlight={[...chat].reverse().find(m => m.role === 'assistant' && m.tickers?.length)?.tickers ?? []} busy={aiBusy} />
                  <section className="cx-chat" aria-label="Cypher assistant">
                    <ol className="cx-thread" ref={threadRef} aria-live="polite">
                      {chat.map((m, i) => (
                        <li key={i} className={`cx-msg ${m.role}`}>
                          {m.role === 'assistant' ? <span className="cx-avatar" aria-hidden="true">C</span> : null}
                          <div className="cx-bubble">
                            {m.typing && !m.text ? <span className="cx-typing" aria-label="Cypher is typing"><i /><i /><i /></span> : <p>{m.text}</p>}
                            {!m.typing && m.tickers?.length ? <div className="cx-answer-chips">{m.tickers.map(t => <button type="button" key={t} className="cx-tk" onClick={() => setSelected(t)}>{byId.get(t)?.company.name ?? t}</button>)}</div> : null}
                            {!m.typing && m.via ? <small>via {m.via}</small> : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                    <div className="cx-suggest">
                      {SUGGESTIONS.map(q => <button type="button" key={q} disabled={asking} onClick={() => void ask(undefined, q)}>{q}</button>)}
                    </div>
                    <form className="cx-ask" onSubmit={ask}>
                      <label className="cx-sr" htmlFor="cx-question">Message Cypher</label>
                      <input id="cx-question" value={question} onChange={e => setQuestion(e.target.value)} placeholder="Message Cypher" maxLength={500} autoComplete="off" />
                      <button type="submit" className="cx-act" disabled={asking || !question.trim()}>{asking ? '…' : 'Send'}</button>
                    </form>
                  </section>
                </>
              ) : (
              <div className="cx-table" role="table" aria-label="Ranked accounts">
                <div className="cx-row cx-th" role="row">
                  <span role="columnheader">#</span><span role="columnheader">Account</span>
                  {KINDS.map(k => <span role="columnheader" key={k.id} className="cx-sig-h">{k.label}</span>)}
                  <span role="columnheader" className="num">Score</span><span role="columnheader">Status</span>
                </div>
                {visible.map((l, i) => (
                  <button type="button" role="row" key={l.id} className={`cx-row ${selected === l.id ? 'sel' : ''}`} onClick={() => setSelected(l.id)}>
                    <span className="cx-rank">{filter === 'All' ? i + 1 : ranked.indexOf(l) + 1}</span>
                    <span className="cx-acct"><b>{l.company.name}</b><small>{l.company.ticker} · {l.company.hq}</small></span>
                    {KINDS.map(k => {
                      const s = l.signals.find(x => x.kind === k.id);
                      return (
                        <span key={k.id} className={`cx-cell${s ? (s.strength / SIGNAL_MAX[k.id] >= .85 ? ' hit strong' : ' hit') : ''}`} style={s ? { ['--heat' as string]: String(Math.max(.18, s.strength / SIGNAL_MAX[k.id])) } : undefined} title={s ? `${s.headline} (${s.source === 'live' ? 'live' : s.source === 'ai' ? 'AI research' : 'demo estimate'})` : `No ${k.label.toLowerCase()} signal`}>
                          <em>{k.label}</em>{s ? s.metric : '—'}{s?.source === 'live' ? <i aria-label="live" /> : s?.source === 'ai' ? <i className="ai" aria-label="AI research" /> : null}
                        </span>
                      );
                    })}
                    <span className="cx-score num"><b>{l.score}</b><span className={`cx-tier ${l.tier.toLowerCase()}`}>{l.tier}</span></span>
                    <span className={`cx-stage ${l.stage}`}>{aiBusy.includes(l.id) ? 'Researching…' : stageLabel(l.stage)}</span>
                  </button>
                ))}
                {pending.map(c => (
                  <div role="row" key={c.ticker} className="cx-row pending">
                    <span className="cx-rank">·</span>
                    <span className="cx-acct"><b>{c.name}</b><small>{c.ticker} · {scanning.includes(c.ticker) ? 'checking filings and job boards' : 'queued'}</small></span>
                    {KINDS.map(k => <span key={k.id} className="cx-cell"><em>{k.label}</em></span>)}
                    <span className="cx-score num" /><span className="cx-stage" />
                  </div>
                ))}
                {!rows.length && !running ? territory.map((c, i) => (
                  <div role="row" key={c.ticker} className="cx-row idle">
                    <span className="cx-rank">{i + 1}</span>
                    <span className="cx-acct"><b>{c.name}</b><small>{c.ticker} · {c.hq}</small></span>
                    {KINDS.map(k => <span key={k.id} className="cx-cell"><em>{k.label}</em></span>)}
                    <span className="cx-score num" /><span className="cx-stage">Not scanned</span>
                  </div>
                )) : null}
              </div>
              )}
            </>
          ) : (
            <div className="cx-pipe">
              {STAGES.map(stage => {
                const items = ranked.filter(l => l.stage === stage.id);
                return (
                  <section key={stage.id} className="cx-lane" aria-label={stage.label}>
                    <h3><span>{stage.label}</span><span className="num">{items.length}</span></h3>
                    {items.length ? items.map(l => (
                      <button type="button" key={l.id} className="cx-ticket" onClick={() => setSelected(l.id)}>
                        <span className="row"><b>{l.company.name}</b><span className={`cx-tier ${l.tier.toLowerCase()}`}>{l.score}</span></span>
                        <small>{l.why}</small>
                        <small className="next">Next: {l.sequence.find(t => t.day > 0)?.channel} on {l.sequence.find(t => t.day > 0)?.due}</small>
                      </button>
                    )) : <p className="cx-lane-empty">Nothing here yet</p>}
                  </section>
                );
              })}
            </div>
          )}
        </section>

        <aside className="cx-log" aria-label="Run log">
          <div className="cx-log-head"><span className="cx-label">Run log</span></div>
          <ol ref={logRef} aria-live="polite">
            {steps.length ? steps.map((s, i) => (
              <li key={i} className={s.tone || 'info'}>
                <time>{clock(s.at)}</time>
                <span>{s.ticker ? <button type="button" className="cx-tk" onClick={() => byId.has(s.ticker!) && setSelected(s.ticker!)}>{s.ticker}</button> : null}{s.text}</span>
              </li>
            )) : <li className="info empty"><span>Each source Cypher checks, every score, draft and send is written here as it happens.</span></li>}
          </ol>
        </aside>
      </main>

      {lead ? (
        <div className="cx-scrim" onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
          <article className="cx-dossier" role="dialog" aria-modal="true" aria-labelledby="cx-dossier-title">
            <header>
              <div>
                <p className="cx-label">{lead.company.ticker}{lead.company.domain ? ` · ${lead.company.domain}` : ''} · {lead.company.hq}</p>
                <h2 id="cx-dossier-title">{lead.company.name}</h2>
              </div>
              <div className="cx-dossier-score"><b className="num">{lead.score}</b><span className={`cx-tier ${lead.tier.toLowerCase()}`}>{lead.tier}</span></div>
              <button type="button" className="cx-close" aria-label="Close" autoFocus onClick={() => setSelected(null)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
            </header>

            <p className="cx-why"><span className="cx-label">Why now</span>{lead.why}</p>
            {lead.ai ? <p className="cx-ai-note">Researched by {shortModel(lead.ai.model)}{lead.ai.web ? ' with live web search' : ''} · {new Date(lead.ai.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p> : null}

            <h3 className="cx-label">Evidence</h3>
            <ul className="cx-evidence">
              {lead.signals.length ? lead.signals.map(s => (
                <li key={s.kind}>
                  <div className="row">
                    <span className="k">{KINDS.find(k => k.id === s.kind)?.label}</span>
                    <b>{s.headline}</b>
                    <span className={`src ${s.source}`}>{s.source === 'live' ? 'Live' : s.source === 'ai' ? 'AI research' : 'Demo estimate'}</span>
                    <span className="pts num">+{s.strength}</span>
                  </div>
                  <ul>{s.evidence.map((ev, i) => <li key={i}>{ev.url ? <a href={ev.url} target="_blank" rel="noreferrer">{ev.label}</a> : ev.label}{ev.date && !ev.label.includes(ev.date) ? <span> · {ev.date}</span> : null}</li>)}</ul>
                </li>
              )) : <li>No strong signals yet. Keep this account on watch.</li>}
            </ul>

            {(() => {
              const intel = accountIntel(lead);
              const activity = steps.filter(x => x.ticker === lead.id).slice(-6);
              return (
                <>
                  <h3 className="cx-label">Account intelligence</h3>
                  <div className="cx-intel">
                    <div><span>Est. deal size</span><b>{intel.dealSize}</b><small>{intel.seats} seats</small></div>
                    <div><span>Buying window</span><b>{intel.window}</b><small>{lead.tier} tier</small></div>
                    <div><span>Confidence</span><b>{intel.confidence}</b><small>{lead.signals.filter(x => x.source !== 'snapshot').length} verified signals</small></div>
                    <div><span>Fit score</span><b>{lead.score}/100</b><small>{intel.fit.filter(f => f.points).length} of 4 signals firing</small></div>
                  </div>
                  <ul className="cx-fit">
                    {intel.fit.map(f => <li key={f.label}><span>{f.label}</span><i><em style={{ width: `${Math.round(f.points / f.max * 100)}%` }} /></i><b className="num">{f.points}/{f.max}</b></li>)}
                  </ul>
                  <p className="cx-intel-note">Cypher estimates from the signals above.</p>

                  <h3 className="cx-label">Buying committee</h3>
                  <ul className="cx-committee">
                    {intel.committee.map(m => <li key={m.role}><span className="r">{m.role}</span><b>{m.title}</b><small>{m.why}</small></li>)}
                  </ul>

                  <h3 className="cx-label">Recommended play</h3>
                  <div className="cx-play">
                    <b>{intel.play.name}</b>
                    <ol>{intel.play.talkTrack.map((t, i) => <li key={i}>{t}</li>)}</ol>
                    <div className="cx-reach"><span><em>Channel</em>{intel.channel}</span><span><em>Best time</em>{intel.timing}</span></div>
                  </div>

                  <h3 className="cx-label">Objection prep</h3>
                  <ul className="cx-objections">
                    {intel.play.objections.map(o => <li key={o.objection}><b>&ldquo;{o.objection}&rdquo;</b><span>{o.answer}</span></li>)}
                  </ul>

                  {activity.length ? (
                    <>
                      <h3 className="cx-label">Activity</h3>
                      <ol className="cx-activity">{activity.map((a, i) => <li key={i}><time>{clock(a.at)}</time><span>{a.text}</span></li>)}</ol>
                    </>
                  ) : null}
                </>
              );
            })()}

            <h3 className="cx-label">Buyer</h3>
            <div className="cx-buyer">
              <span>{lead.buyer.name ? <><b>{lead.buyer.name}</b>, {lead.buyer.title || lead.buyer.persona}{lead.buyer.source ? <> · <a className="cx-inline" href={lead.buyer.source} target="_blank" rel="noreferrer">source</a></> : null}</> : <><b>{lead.buyer.persona}</b>, {lead.company.name}</>}</span>
              <a href={lead.buyer.linkedin} target="_blank" rel="noreferrer">Search LinkedIn</a>
              <a href={lead.buyer.apollo} target="_blank" rel="noreferrer">Search Apollo</a>
            </div>

            <h3 className="cx-label">First email</h3>
            <label className="cx-sr" htmlFor="cx-subject">Subject</label>
            <input id="cx-subject" className="cx-subject" value={lead.email.subject} onChange={e => update(lead.id, { email: { ...lead.email, subject: e.target.value } })} />
            <label className="cx-sr" htmlFor="cx-body">Email body</label>
            <textarea id="cx-body" className="cx-body" value={lead.email.body} rows={11} onChange={e => update(lead.id, { email: { ...lead.email, body: e.target.value } })} />

            <h3 className="cx-label">Sequence</h3>
            <ol className="cx-seq">
              {lead.sequence.map(t => (
                <li key={t.day} className={lead.stage !== 'drafted' && t.day === 0 ? 'done' : ''}>
                  <span className="d num">Day {t.day}</span><span className="ch">{t.channel}</span><span className="a">{t.action}</span><time className="num">{t.due}</time>
                </li>
              ))}
            </ol>

            <footer>
              <button type="button" className="cx-btn" disabled={!!aiProgress} onClick={() => void research([lead])}>{aiBusy.includes(lead.id) ? 'Researching…' : lead.ai ? 'Research again' : 'Research with AI'}</button>
              {lead.stage === 'drafted' ? <button type="button" className="cx-act" disabled={dispatching} onClick={() => void launch([lead])}>{dispatching ? 'Starting…' : 'Start sequence'}</button> : null}
              {lead.stage === 'drafted' ? <><a className="cx-btn" href={`https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(lead.email.subject)}&body=${encodeURIComponent(lead.email.body)}`} target="_blank" rel="noreferrer">Open in Gmail</a><button type="button" className="cx-btn" disabled={dispatching} title="Choose after sending the email in Gmail" onClick={() => move(lead, 'sent')}>Mark as sent</button></> : null}
              <button type="button" className="cx-btn" onClick={() => void copyEmail(lead)}>Copy email</button>
              {lead.stage === 'sent' ? <button type="button" className="cx-btn" onClick={() => move(lead, 'replied')}>Mark replied</button> : null}
              {lead.stage === 'sent' || lead.stage === 'replied' ? <button type="button" className="cx-act" onClick={() => move(lead, 'meeting')}>Meeting booked</button> : null}
              {lead.sentAt ? <span className="cx-status">Sent {new Date(lead.sentAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> : null}
            </footer>
          </article>
        </div>
      ) : null}
      {toast ? <div className="cx-toast" role="status">{toast}</div> : null}
    </div>
  );
}
