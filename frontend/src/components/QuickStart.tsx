import { MODEL_CHOICES } from '../lib/presets';
import { GlassSelect } from './GlassSelect';
import BinaryLens from './cipher/BinaryLens';
import { RecentWork } from './cipher/RecentWork';
import { useEffect, useRef, useState } from 'react';
import { RunOptions, Attachment } from '../lib/types';
import { readTaskAttachments } from '../lib/attachments';

const STARTER_PROMPTS = [
  { text: 'Find people or companies', description: 'Build lists, research, and find the right contacts.', prompt: 'Find relevant people or companies for: ', icon: 'search' },
  { text: 'Prepare for a meeting', description: 'Get briefs, background research, and talking points.', prompt: 'Prepare a meeting brief for: ', icon: 'calendar' },
  { text: 'Research a topic', description: 'Deep research with sources and clear summaries.', prompt: 'Research this topic and give me a clear, sourced brief: ', icon: 'document' },
  { text: 'Create something', description: 'Draft emails, documents, presentations, or more.', prompt: 'Create a first draft of: ', icon: 'sparkles' },
];

function StarterIcon({ name }: { name: string }) {
  if (name === 'search') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 4.3 4.3"/></svg>;
  if (name === 'calendar') return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M8 3v4m8-4v4M4 9h16M8 13h2m4 0h2m-8 3h2"/></svg>;
  if (name === 'document') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20H7a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2Z"/><path d="M14 3.5v4h4M9 12h6m-6 3h6"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Zm6 12 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z"/></svg>;
}

export function QuickStart({ onStart, onOpenRecent, onVoiceStart, options, onOptions, draftScope }: { draftScope?: string; options: RunOptions; onOptions: (options: RunOptions) => void; onStart: (prompt: string, options: Partial<RunOptions>, attachments?: Attachment[]) => Promise<void>; onOpenRecent: (conversationId: string) => void; onVoiceStart: (stream: MediaStream) => Promise<void> }) {
  const manager = options.routing==='manual'?(options.model || 'gpt-6.1-sol'):'auto';
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const readingFilesRef = useRef(false);
  const logoRef = useRef<HTMLDivElement>(null);
  const [logoMotionActive, setLogoMotionActive] = useState(false);
  const [homeHasEntered, setHomeHasEntered] = useState(false);
  const draftKey='grokbot-task-draft-v1-'+(draftScope || 'local');
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [restoredDraftKey, setRestoredDraftKey] = useState('');
  useEffect(() => { try { setPrompt(sessionStorage.getItem(draftKey) || ''); } catch {} setRestoredDraftKey(draftKey); }, [draftKey]);
  useEffect(() => { if(restoredDraftKey===draftKey) try { if(prompt) sessionStorage.setItem(draftKey,prompt); else sessionStorage.removeItem(draftKey); } catch {} }, [prompt,restoredDraftKey,draftKey]);
  useEffect(() => {
    const logo = logoRef.current;
    if (!logo) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let isVisible = false;
    const syncMotion = () => {
      const active = isVisible && !document.hidden && !reducedMotion.matches && document.documentElement.dataset.motion !== 'false';
      setLogoMotionActive(active);
      if (active) setHomeHasEntered(true);
    };
    const visibilityObserver = new IntersectionObserver(([entry]) => { isVisible = entry.isIntersecting; syncMotion(); }, { threshold: 0.1 });
    const settingsObserver = new MutationObserver(syncMotion);
    visibilityObserver.observe(logo);
    settingsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    document.addEventListener('visibilitychange', syncMotion);
    reducedMotion.addEventListener('change', syncMotion);
    return () => {
      visibilityObserver.disconnect();
      settingsObserver.disconnect();
      document.removeEventListener('visibilitychange', syncMotion);
      reducedMotion.removeEventListener('change', syncMotion);
    };
  }, []);
  const [output, setOutput] = useState<'text' | 'image'>('text');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  async function startVoice() {
    if (voiceBusy) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setVoiceError('Voice chat needs a browser that supports microphone recording.'); return; }
    setVoiceBusy(true); setVoiceError('');
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      await onVoiceStart(stream);
    } catch (failure) {
      stream?.getTracks().forEach(track => track.stop());
      setVoiceError(failure instanceof Error ? failure.message : 'Microphone access was not available.');
    } finally { setVoiceBusy(false); }
  }
  async function addFiles(files: FileList | null) {
    if (!files?.length || busy || readingFilesRef.current) return;
    readingFilesRef.current = true;
    setReadingFiles(true);
    setError('');
    try {
      const loaded = await readTaskAttachments(Array.from(files), attachments);
      setAttachments(current => [...current, ...loaded]);
      setOutput('text');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The files could not be added. Try again.');
    } finally {
      readingFilesRef.current = false;
      setReadingFiles(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function start(e: React.FormEvent) {
    e.preventDefault();
    if ((!prompt.trim() && !attachments.length) || busy || readingFilesRef.current || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await onStart(prompt || 'Review the attached files.', {
        ...options, output: attachments.length ? 'text' : output,
        provider: manager === 'auto' ? 'openai' : MODEL_CHOICES.find(choice => choice.model === manager)?.provider || options.provider || 'openai',
        model: manager === 'auto' ? 'gpt-6.1-sol' : manager, aspect_ratio: '16:9', duration: 4,
      }, attachments);
      if (mounted.current) { setPrompt(''); setAttachments([]); }
      try { if (sessionStorage.getItem(draftKey) === prompt) sessionStorage.removeItem(draftKey); } catch {}
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : 'The task could not start. Try again.';
      setError(detail + ' Your task is still here.');
    } finally { inFlight.current = false; setBusy(false); }
  }
  return (
    <div className="quickstart">
      <div className="quickstart-panel" data-motion-entered={homeHasEntered}>
      <div className="quickstart-mark" ref={logoRef} data-motion-active={logoMotionActive}>
        <BinaryLens className="quickstart-real-lens" active={logoMotionActive} label="Cypher binary lens" />
      </div>
      <h1>What would you like to get done?</h1>
      <p className="quickstart-intro">Describe a task. The right tools come together automatically.</p>

      <form onSubmit={start} className="task-composer" aria-busy={busy || readingFiles} data-motion-active={logoMotionActive}>
        <input ref={fileInput} className="visually-hidden" type="file" multiple aria-label="Choose task files" accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.json,.mp3,.wav,.m4a,.ogg,.flac,.mp4,.webm,.mov" onChange={event => void addFiles(event.target.files)}/>
        <button type="button" className="task-attach-button" aria-label="Attach files to task" title="Attach files" disabled={busy || readingFiles} onClick={() => fileInput.current?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 12 5.5-5.5a3.2 3.2 0 0 1 4.5 4.5l-7.5 7.5a4.5 4.5 0 0 1-6.4-6.4L12 3.7m-2.7 8.9 5.2-5.2"/></svg>
        </button>
        <label className="visually-hidden" htmlFor="first-task">Your task</label>
        <textarea
          disabled={busy || readingFiles}
          id="first-task"
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={output === 'image' ? 'Describe the image you have in mind…' : 'Ask anything…'}
          rows={1}
          maxLength={20000}
        />
        <div className="task-composer-footer">
          <details className="quickstart-options">
            <summary aria-label="Task options" title="Task options"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 0 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 0 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 0 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z"/></svg></summary>
            <div className="task-composer-options">
          <GlassSelect
            disabled={busy}
            aria-label="Manager model"
            value={manager}
            onChange={event => {
              const selectedModel = event.target.value;
              onOptions({
                ...options,
                routing: selectedModel === 'auto' ? 'auto' : 'manual',
                provider: MODEL_CHOICES.find(model => model.model === selectedModel)?.provider || 'openai',
                model: selectedModel === 'auto' ? 'gpt-6.1-sol' : selectedModel,
              });
              try { localStorage.setItem('grokbot-manager', selectedModel); } catch {}
            }}
          >
            <option value="auto">Auto</option>
            {MODEL_CHOICES.map(model => <option key={model.id} value={model.model}>{model.label}</option>)}
          </GlassSelect>
          <GlassSelect disabled={busy} aria-label="Task output" value={output} onChange={event => setOutput(event.target.value as 'text' | 'image')}>
            <option value="text">Text</option>
            <option value="image" disabled={attachments.length > 0}>Create an image</option>
          </GlassSelect>
            </div>
          </details>
          <button
            type="button"
            className="quickstart-voice"
            onClick={() => void startVoice()}
            disabled={voiceBusy}
            aria-label={voiceBusy ? 'Connecting microphone' : 'Start voice chat'}
            title={voiceBusy ? 'Connecting microphone' : 'Voice chat'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/></svg>
            <span>{voiceBusy ? 'Connecting microphone…' : 'Voice chat'}</span>
          </button>
          <button aria-label={busy ? 'Starting task' : 'Start task'} disabled={busy || readingFiles || (!prompt.trim() && !attachments.length)} type="submit" className="btn-primary quickstart-submit">
            <span className="visually-hidden">{busy ? 'Starting…' : 'Start task'}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
          </button>
        </div>
      </form>
      {readingFiles ? <p className="home-file-status" role="status">Adding files…</p> : null}
      {attachments.length ? <ul className="home-attachments" aria-label="Attached files">{attachments.map((file, index) => <li key={`${file.name}-${index}`}>
        <span title={file.name}>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} disabled={busy || readingFiles} onClick={() => setAttachments(current => current.filter((_, item) => item !== index))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
      </li>)}</ul> : null}

      {voiceError ? <p className="quickstart-error" role="alert">{voiceError}</p> : null}

      {error ? <p className="quickstart-error" role="alert">{error}</p> : null}

      <nav className="starter-prompts" aria-label="Start with an idea">
          {STARTER_PROMPTS.map(item => (
            <button
              type="button"
              disabled={busy}
              key={item.text}
              onClick={() => {
                setPrompt(item.prompt);
                setOutput('text');
                document.getElementById('first-task')?.focus();
              }}
              className="starter-card"
            >
              <StarterIcon name={item.icon}/>
              <strong>{item.text}</strong>
              <span>{item.description}</span>
            </button>
          ))}
      </nav>

      <RecentWork onOpen={onOpenRecent} />

      <span className={busy ? 'quickstart-status' : 'visually-hidden'} role="status">{busy ? <><BinaryLens className="quickstart-busy-lens" active={logoMotionActive} label="Cypher working" />Opening your conversation…</> : ''}</span>
      </div>
    </div>
  );
}
