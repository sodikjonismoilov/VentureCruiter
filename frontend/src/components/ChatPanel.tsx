import { LoadingState } from './LoadingState';
import { MODEL_CHOICES } from '../lib/presets';
import { ContextPanel } from './ContextPanel';
import { WorkPanel } from './WorkPanel';
import { GlassSelect } from './GlassSelect';
import React, { useEffect, useState, useRef } from 'react';
import { Bot, Message, MessageType, Attachment, Conversation, Job, RunOptions } from '../lib/types';
import { api, ApiError } from '../lib/api';
import { BotAvatar } from './BotAvatar';
import { MessageBubble } from './MessageBubble';
import { QuickStart } from './QuickStart';
import { RunControls, DEFAULT_OPTIONS } from './RunControls';
import { modelPolicy } from '../lib/modelPolicy';
import { readAttachment } from '../lib/attachments';
import BinaryLens from './cipher/BinaryLens';
import CypherMark from './cipher/CypherMark';
import { playVoiceResponse, speakWithBrowser } from '../lib/voice-playback';
const POLL_MS = 1500;
const MAX_BYTES = 3 * 1024 * 1024;
export function messageTime(value: string) {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z');
}
export function sameMessageGroup(previous: Message | undefined, current: Message | undefined) {
  if (!previous || !current || previous.senderType !== current.senderType || previous.senderBotId !== current.senderBotId) return false;
  const previousTime = messageTime(previous.createdAt);
  const currentTime = messageTime(current.createdAt);
  const gap = currentTime.getTime() - previousTime.getTime();
  return gap >= 0 && gap < 300000 && previousTime.toDateString() === currentTime.toDateString();
}
function messageDateLabel(value: string) {
  const date = messageTime(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toDateString() === new Date().toDateString() ? 'Today' : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day} · ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
type VoiceStatus = 'off' | 'listening' | 'recording' | 'thinking' | 'speaking' | 'error';
const VOICE_STATUS_LABEL: Record<VoiceStatus, string> = { off: 'Voice off', listening: 'Listening', recording: 'I’m listening', thinking: 'Cypher is thinking', speaking: 'Cypher is speaking', error: 'Voice needs attention' };
function speechText(content: string) {
  const plain = content.replace(/```[\s\S]*?```/g, ' Code block omitted. ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/^\s{0,3}#{1,6}\s*/gm, '').replace(/^\s*>\s?/gm, '').replace(/[*_~]{1,3}/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= 1800) return plain;
  const clipped = plain.slice(0, 1800);
  const sentenceEnd = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('? '), clipped.lastIndexOf('! '));
  const wordEnd = clipped.lastIndexOf(' ');
  const end = sentenceEnd > 900 ? sentenceEnd + 1 : wordEnd > 900 ? wordEnd : clipped.length;
  return clipped.slice(0, end) + ' Cypher has more detail on screen.';
}
export function ChatPanel({ bot, room, bots, onCreateBot, onCreateRoom, onQuickStart, onOpenLounge, onOpenSetup, onOpenRecent, onVoiceStart, voiceMode = false, voiceStream, onVoiceStream, onVoiceStop, draftScope }: { draftScope?: string; bot: Bot | null; room: Conversation | null; bots: Bot[]; onCreateBot: () => void; onCreateRoom: () => void; onQuickStart: (prompt: string, options: Partial<import('../lib/types').RunOptions>, attachments?: Attachment[]) => Promise<void>; onOpenLounge: () => Promise<Conversation>; onOpenSetup?: () => void; onOpenRecent: (conversationId: string) => void; onVoiceStart: (stream: MediaStream) => Promise<void>; voiceMode?: boolean; voiceStream: MediaStream | null; onVoiceStream: (stream: MediaStream) => void; onVoiceStop: () => void }) {
  const [conversationId, setConversationId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [input, setInput] = useState('');
  const [replyTo,setReplyTo]=useState<Message|null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [loading, setLoading] = useState(!!bot || !!room);
  const [syncError, setSyncError] = useState('');
  const [syncAttempt,setSyncAttempt] = useState(0);
  const [refreshing,setRefreshing] = useState(false);
  const [sessionExpired,setSessionExpired] = useState(false);
  const [retryAt,setRetryAt] = useState(0);
  const retryNotBefore = useRef(0);
  const retryOpening = useRef(false);
  useEffect(()=>{if(!retryAt)return;const timer=setTimeout(()=>{retryNotBefore.current=0;setRetryAt(0);},Math.max(0,retryAt-Date.now()));return()=>clearTimeout(timer);},[retryAt]);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [messageQuery, setMessageQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTrigger=useRef<HTMLButtonElement>(null);
  function closeSearch(){setSearchOpen(false);setMessageQuery('');searchTrigger.current?.focus();}
  const settings = useRef<HTMLDetailsElement>(null);
  const draftKey = 'grokbot-draft-' + (room?.id || bot?.id || 'home');
  useEffect(() => { try { setInput(sessionStorage.getItem(draftKey) || ''); } catch {} setDraftReady(true); }, [draftKey]);
  useEffect(() => { if(draftReady) try { if(input) sessionStorage.setItem(draftKey, input); else sessionStorage.removeItem(draftKey); } catch {} }, [draftKey, input, draftReady]);
  useEffect(() => {
    function close(event: KeyboardEvent | globalThis.PointerEvent) {
      if (!settings.current?.open) return;
      if(event.type === 'keydown' && !event.defaultPrevented && (event as KeyboardEvent).key === 'Escape') { settings.current.open=false; settings.current.querySelector('summary')?.focus(); }
      else if(event.type === 'pointerdown' && !settings.current.contains(event.target as Node) && !(event.target as HTMLElement).closest('[role=listbox],[role=option]')) settings.current.open=false;
    }
    document.addEventListener('keydown',close); document.addEventListener('pointerdown',close);
    return () => { document.removeEventListener('keydown',close);document.removeEventListener('pointerdown',close); };
  }, []);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [readingFiles,setReadingFiles]=useState(false);
  const [draggingFiles,setDraggingFiles]=useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const unconfirmedDraft = useRef<{id:string;text:string;files:Attachment[];reply?:string} | null>(null);
  const [computerBotId, setComputerBotId] = useState<string | null>(null);
  const [computerBusy, setComputerBusy] = useState(false);
  const [computerError, setComputerError] = useState('');
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('off');
  const [voiceError, setVoiceError] = useState('');
  const voiceStatusRef = useRef<VoiceStatus>('off');
  const voiceModeRef = useRef(voiceMode);
  const voicePending = useRef<{ messageId: string; taskId: string | null } | null>(null);
  const voicePanel = useRef<HTMLDivElement>(null);
  const voiceButton = useRef<HTMLButtonElement>(null);
  const voiceAudio = useRef<HTMLAudioElement>(null);
  const voiceSession = useRef(0);
  const voiceStarting = useRef(false);
  const voiceLevel = useRef(0);
  const voiceRequest = useRef<AbortController | null>(null);
  const voiceContext = useRef<AudioContext | null>(null);
  const voiceOutputAnalyser = useRef<AnalyserNode | null>(null);
  const voiceOutputSource = useRef<MediaElementAudioSourceNode | null>(null);
  const voiceTurnHandler = useRef<(file: Attachment) => Promise<void>>(async () => {});
  function updateVoiceStatus(status: VoiceStatus) { voiceStatusRef.current = status; setVoiceStatus(status); }
  const [options, setOptions] = useState<RunOptions>(() => ({ ...DEFAULT_OPTIONS, provider: 'openai', model: 'gpt-6.1-sol', ...bot?.defaultOptions }));
  const [optionsRestored, setOptionsRestored] = useState(false);
  useEffect(() => {
    try { setOptions({ ...DEFAULT_OPTIONS, provider: 'openai', model: localStorage.getItem('grokbot-manager') === 'gpt-6-luna' ? 'gpt-6-luna' : 'gpt-6.1-sol', ...bot?.defaultOptions, ...modelPolicy(JSON.parse(localStorage.getItem('grokbot-options-' + bot?.id) || '{}')) }); }
    catch { /* Keep the deterministic defaults when browser storage is unavailable. */ }
    setOptionsRestored(true);
  }, [bot?.id]);
  useEffect(() => { if (optionsRestored && bot) { try { localStorage.setItem('grokbot-options-' + bot.id, JSON.stringify(options)); } catch {} } }, [options, bot?.id, optionsRestored]);
  const [font, setFont] = useState('system');
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const prependOffset = useRef<number | null>(null);
  const firstPage = useRef(true);
  const stream = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const followLatest = useRef(true);
  const roomMembers = room?.is_group ? bots.filter(member=>room.bot_ids.includes(member.id)) : [];
  const title = room?.title === 'Agent lounge' ? 'Your team' : room?.title || bot?.name || 'Workspace';
  useEffect(() => { const el = stream.current; if (!el) return; if (prependOffset.current !== null) { el.scrollTop = el.scrollHeight - prependOffset.current; prependOffset.current = null; } else if (followLatest.current) el.scrollTop = el.scrollHeight; }, [messages.length, messages[messages.length - 1]?.id, voiceMode]);
  useEffect(()=>{followLatest.current=true;setConversationId('');setMessages([]);setJobs([]);setAttachments([]);setError('');setLoading(!!bot || !!room);setSyncError('');setSessionExpired(false);retryNotBefore.current=0;setRetryAt(0);firstPage.current=true;},[bot?.id,room?.id]);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>; let failures=0; let pending=false; let refreshRequested=false;
    const controller=new AbortController();
    if (!bot && !room) return;
    retryOpening.current=true;setRefreshing(true);
    let currentId='';let latestMessageId:string|undefined;
    const poll = async () => {
      if(!active || pending || !currentId || Date.now()<retryNotBefore.current)return;
      pending=true; clearTimeout(timer); let delay=10000;
      try { const {messages:data,tasks}=await api.syncConversation(currentId,latestMessageId,controller.signal); if(active){failures=0;if(data.length)latestMessageId=data[data.length-1].id;if(firstPage.current){setHasEarlier(data.length===50);firstPage.current=false;}setMessages(previous=>mergeMessages(previous,data));setJobs(tasks);setLoading(false);setSyncError('');setSessionExpired(false);delay=tasks.some(t=>['pending','running','cancel_requested'].includes(t.status))?POLL_MS:10000;} }
      catch(e){if(active){failures++;setLoading(false);setSessionExpired(e instanceof ApiError && e.status===401);const wait=e instanceof ApiError?Math.max(0,e.retryAfter*1000):0;retryNotBefore.current=wait?Date.now()+wait:0;setRetryAt(retryNotBefore.current);setSyncError(e instanceof ApiError && e.code==='database_quota'?e.message:e instanceof ApiError && e.status===401?'Your session expired. Sign in again to reconnect.':'Couldn’t refresh this conversation. Your messages are saved; reconnecting automatically…');delay=Math.max(e instanceof ApiError?e.retryAfter*1000:0,Math.min(60000,2000*2**Math.min(failures,5)));}}
      finally{pending=false;if(active){retryOpening.current=false;setRefreshing(false);}if(active){const next=refreshRequested && !failures?0:document.hidden?Math.max(delay,60000):delay;refreshRequested=false;timer=setTimeout(poll,next);}}
    };
    const refresh=()=>{if(document.hidden || Date.now()<retryNotBefore.current)return;if(pending){refreshRequested=true;return;}if(retryOpening.current)return;if(currentId){setRefreshing(true);void poll();}else{retryOpening.current=true;setSyncAttempt(value=>value+1);}};
    document.addEventListener('visibilitychange',refresh);window.addEventListener('grokbot:refresh',refresh);window.addEventListener('online',refresh);
    const load = room ? Promise.resolve(room.id) : api.conversationForBot(bot!);
    load.then(id=>{if(active){currentId=id;setConversationId(id);void poll();}}).catch(e=>{if(active){retryOpening.current=false;setRefreshing(false);setLoading(false);setSessionExpired(e instanceof ApiError && e.status===401);const wait=e instanceof ApiError?Math.max(0,e.retryAfter*1000):0;retryNotBefore.current=wait?Date.now()+wait:0;setRetryAt(retryNotBefore.current);setSyncError(e instanceof ApiError && e.status===401?'Your session expired. Sign in again to reconnect.':(e instanceof ApiError?e.message:'Couldn’t open this conversation.')+' Your draft is kept here. Reconnect to try again.');}});
    return()=>{active=false;controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('grokbot:refresh',refresh);window.removeEventListener('online',refresh);};
  }, [bot?.id, room?.id, syncAttempt]);
  function mergeMessages(previous: Message[], incoming: Message[]) {
    const map = new Map(previous.map(message => [message.id, message])); incoming.forEach(message => map.set(message.id, {...message,delivery:message.delivery || 'sent'}));
    return Array.from(map.values()).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async function loadEarlier() {
    if (!conversationId || !messages.length || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const older = await api.getMessages(conversationId, messages[0].id);
      if (stream.current) prependOffset.current = stream.current.scrollHeight - stream.current.scrollTop;
      followLatest.current = false;
      setMessages(previous => mergeMessages(previous, older)); setHasEarlier(older.length === 50);
    } catch (e) { setError(String(e)); } finally { setLoadingEarlier(false); }
  }
  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError(''); setReadingFiles(true);
    try {
      const list = Array.from(files);
      if (attachments.length + list.length > 4) throw new Error('Attach up to four files per message.');
      const existingBytes = attachments.reduce((sum, a) => sum + Math.floor(a.data.length * .75), 0);
      if (existingBytes + list.reduce((sum, f) => sum + f.size, 0) > MAX_BYTES) throw new Error('Keep combined attachments below 3 MB.');
      const allowed = ['image/png','image/jpeg','image/webp','application/pdf','text/plain','audio/wav','audio/mpeg','audio/mp4','audio/ogg','audio/webm','audio/flac','video/mp4','video/webm','video/quicktime'];
      const loaded = await Promise.all(list.map(file => {
        const extensions:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',md:'text/plain',csv:'text/plain',json:'text/plain',wav:'audio/wav',mp3:'audio/mpeg',m4a:'audio/mp4',ogg:'audio/ogg',flac:'audio/flac',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime'};
        const mime=allowed.includes(file.type)?file.type:extensions[file.name.split('.').pop()?.toLowerCase()||''];
        if (!mime) throw new Error(`${file.name}: use images, PDF, text, audio, MP4, WebM, or MOV.`);
        return readAttachment(file, mime);
      }));
      setAttachments(prev => [...prev, ...loaded]);
      setOptions(current=>({...current,output:'text'}));
    } catch (e) { setError(String(e)); }
    finally { setReadingFiles(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function toggleComputer() {
    if (!bot || computerBusy) return;
    const id = bot.id;
    setComputerBusy(true); setComputerError('');
    try {
      if (computerBotId === id) { await api.stopBot(id); setComputerBotId(null); }
      else { await api.startBot(id); setComputerBotId(id); }
    } catch (e) { setComputerError(e instanceof Error ? e.message : String(e)); }
    finally { setComputerBusy(false); }
  }
  async function send(override?: { text: string; files: Attachment[]; voiceTurn?: boolean }) {
    const text = override?.text ?? input;
    const files = override?.files ?? attachments;
    const isVoiceTurn = override?.voiceTurn === true;
    const session = voiceSession.current;
    if ((!text.trim() && !files.length) || !conversationId || readingFiles || sendingRef.current) {
      if (isVoiceTurn) { setVoiceError('Cypher is still sending another request. Try speaking again.'); updateVoiceStatus('listening'); }
      return;
    }
    sendingRef.current = true;
    const previousDraft=unconfirmedDraft.current;
    const messageId=isVoiceTurn?crypto.randomUUID():previousDraft?.text===text && JSON.stringify(previousDraft.files)===JSON.stringify(files) && previousDraft.reply===replyTo?.id?previousDraft.id:crypto.randomUUID();
    followLatest.current = true;
    setSending(true); setError('');
    if (!isVoiceTurn) { setInput(''); setAttachments([]); const composerInput=document.getElementById("message"); if(composerInput)composerInput.style.height="auto"; }
    const userTurnAt = new Date().toISOString();
    setMessages(previous => mergeMessages(previous, [{id:messageId,conversationId,senderType:'user',content:text,messageType:MessageType.TEXT,createdAt:userTurnAt,attachments:files,threadRootId:replyTo?.threadRootId||replyTo?.id,replyToId:replyTo?.id,delivery:'sending'}]));
    try {
      const accepted = await api.sendMessage(conversationId, text, files, isVoiceTurn ? { ...options, output: 'text' } : options, messageId,replyTo?.id);
      setReplyTo(null);
      unconfirmedDraft.current=null;
      if (isVoiceTurn && voiceModeRef.current && session === voiceSession.current) { voicePending.current={messageId,taskId:accepted.task_id}; setVoiceError(''); }
      window.dispatchEvent(new Event('grokbot:refresh'));
      setMessages(previous=>previous.map(message=>message.id===messageId?{...message,delivery:'sent'}:message));
      setJobs(previous=>previous.some(job=>job.id===accepted.task_id)?previous:[{id:accepted.task_id,title:text.slice(0,100),status:'pending',created_at:new Date().toISOString()},...previous]);
    } catch (e) {
      if (!isVoiceTurn) unconfirmedDraft.current={id:messageId,text,files,reply:replyTo?.id};
      setMessages(previous=>previous.map(message=>message.id===messageId?{...message,delivery:'failed'}:message));
      if (isVoiceTurn && voiceModeRef.current && session === voiceSession.current) { setVoiceError(`I couldn’t send that. ${String(e).replace(/^Error: /,'')}`); updateVoiceStatus('listening'); }
      else if (!isVoiceTurn) { setInput(current=>current || text);setAttachments(current=>current.length?current:files); setError(`Message was not confirmed. ${String(e).replace(/^Error: /,'')} Your message is kept in this thread; resend from the composer to retry.`); }
    } finally { sendingRef.current=false;setSending(false); }
  }
  voiceModeRef.current = voiceMode;
  voiceTurnHandler.current = async file => {
    const transcriptPrompt = 'Voice message attached. Please respond directly to what I said in the recording.';
    await send({ text: transcriptPrompt, files: [file], voiceTurn: true });
  };
  async function toggleVoice() {
    if (voiceMode) { onVoiceStop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setVoiceError('Voice chat needs a browser that supports microphone recording.'); return; }
    if (voiceStarting.current) return;
    voiceStarting.current = true;
    const session = voiceSession.current;
    setVoiceError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (session !== voiceSession.current) { stream.getTracks().forEach(track => track.stop()); return; }
      onVoiceStream(stream);
    } catch (failure) { if (session === voiceSession.current) setVoiceError(failure instanceof Error ? failure.message : 'Microphone access was not available.'); }
    finally { voiceStarting.current = false; }
  }
  async function speakReply(content: string) {
    const text = speechText(content);
    if (!text) { updateVoiceStatus('listening'); return; }
    const controller = new AbortController();
    voiceRequest.current?.abort();
    voiceRequest.current = controller;
    try {
      const response = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(typeof detail.detail === 'string' ? detail.detail : 'Cypher’s voice could not be generated.');
      }
      if (controller.signal.aborted || !voiceModeRef.current) return;
      const audio = voiceAudio.current;
      if (!audio) throw new Error('Audio playback is unavailable.');
      await playVoiceResponse(response, audio, controller.signal, () => {
        if (!controller.signal.aborted) updateVoiceStatus('speaking');
      });
      if (!controller.signal.aborted && voiceModeRef.current) updateVoiceStatus('listening');
    } catch (failure) {
      if (controller.signal.aborted || !voiceModeRef.current) return;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          updateVoiceStatus('speaking');
          await speakWithBrowser(text, controller.signal);
          if (!controller.signal.aborted && voiceModeRef.current) updateVoiceStatus('listening');
        } catch (fallbackFailure) {
          if (!controller.signal.aborted && voiceModeRef.current) {
            setVoiceError(fallbackFailure instanceof Error ? fallbackFailure.message : 'Cypher’s voice could not be played.');
            updateVoiceStatus('listening');
          }
        }
      } else {
        setVoiceError(failure instanceof Error ? failure.message : 'Cypher’s voice could not be played.');
        updateVoiceStatus('listening');
      }
    } finally {
      if (voiceRequest.current === controller) voiceRequest.current = null;
    }
  }

  useEffect(() => {
    const pending = voicePending.current;
    if (!voiceMode || !pending?.taskId) return;
    const job = jobs.find(item => item.id === pending.taskId);
    if (!job || ['pending','running','cancel_requested'].includes(job.status)) return;
    const userIndex = messages.findIndex(message => message.id === pending.messageId);
    const replies = userIndex < 0 ? [] : messages.slice(userIndex + 1).filter(message => message.senderType !== 'user' && message.messageType === MessageType.TEXT && !message.internal && message.content.trim());
    const reply = replies[replies.length - 1];
    if (reply) { voicePending.current = null; void speakReply(reply.content); }
    else if (['failed','cancelled','interrupted','completed'].includes(job.status)) { voicePending.current = null; setVoiceError('Cypher could not return a spoken answer. Check the task details, then try again or type a message.'); updateVoiceStatus('listening'); }
  }, [jobs, messages, voiceMode]);
  useEffect(() => {
    if (!voiceMode || !voiceStream || !conversationId) {
      if (!voiceMode) updateVoiceStatus('off');
      return;
    }
    voiceSession.current++;
    const activeStream = voiceStream;
    let stopped = false;
    let frame = 0;
    let recorder: MediaRecorder | null = null;
    let chunks: BlobPart[] = [];
    let lastVoiceAt = 0;
    let startedAt = 0;
    let micSource: MediaStreamAudioSourceNode | null = null;
    let micAnalyser: AnalyserNode | null = null;
    let outputData: Uint8Array<ArrayBuffer> | null = null;
    let micData: Uint8Array<ArrayBuffer> | null = null;
    try {
      const context = voiceContext.current || new AudioContext();
      voiceContext.current = context;
      micAnalyser = context.createAnalyser(); micAnalyser.fftSize = 512;
      micSource = context.createMediaStreamSource(activeStream); micSource.connect(micAnalyser);
      if (voiceAudio.current && !voiceOutputSource.current) {
        voiceOutputAnalyser.current = context.createAnalyser(); voiceOutputAnalyser.current.fftSize = 512;
        voiceOutputSource.current = context.createMediaElementSource(voiceAudio.current);
        voiceOutputSource.current.connect(voiceOutputAnalyser.current); voiceOutputAnalyser.current.connect(context.destination);
      }
      void context.resume().catch(() => {});
      micData = new Uint8Array(new ArrayBuffer(micAnalyser.frequencyBinCount));
      if (voiceOutputAnalyser.current) outputData = new Uint8Array(new ArrayBuffer(voiceOutputAnalyser.current.frequencyBinCount));
    } catch {
      setVoiceError('This browser could not start audio monitoring. Check microphone access and try again.');
      updateVoiceStatus('error');
      return () => { stopped = true; };
    }
    const supported = ['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
    function finishRecording() { if (recorder && recorder.state !== 'inactive') { updateVoiceStatus('thinking'); recorder.stop(); } }
    function beginRecording() {
      try {
        recorder = supported ? new MediaRecorder(activeStream, { mimeType: supported }) : new MediaRecorder(activeStream);
        chunks = []; startedAt = Date.now(); lastVoiceAt = startedAt;
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => {
          if (stopped) return;
          const rawMime = recorder?.mimeType.toLowerCase() || supported || 'audio/webm';
          const mime = rawMime.includes('mp4') ? 'audio/mp4' : rawMime.includes('ogg') ? 'audio/ogg' : 'audio/webm';
          const blob = new Blob(chunks, { type: mime }); chunks = []; recorder = null;
          if (blob.size < 800) { setVoiceError('I didn’t catch that. Please try speaking again.'); updateVoiceStatus('listening'); return; }
          if (blob.size > MAX_BYTES) { setVoiceError('That recording was too long. Please keep each request under 45 seconds.'); updateVoiceStatus('listening'); return; }
          const extension = mime === 'audio/mp4' ? 'm4a' : mime === 'audio/ogg' ? 'ogg' : 'webm';
          const file = new File([blob], `cypher-voice-${Date.now()}.${extension}`, { type: mime });
          void readAttachment(file, mime).then(attachment => { if (!stopped) return voiceTurnHandler.current(attachment); }).catch(failure => { if (!stopped) { setVoiceError(failure instanceof Error ? failure.message : 'The recording could not be sent.'); updateVoiceStatus('listening'); } });
        };
        recorder.start(250); updateVoiceStatus('recording');
      } catch (failure) { setVoiceError(failure instanceof Error ? failure.message : 'The microphone recorder could not start.'); updateVoiceStatus('error'); }
    }
    function measure() {
      if (stopped) return;
      const currentStatus = voiceStatusRef.current;
      const analyser = currentStatus === 'speaking' && voiceOutputAnalyser.current ? voiceOutputAnalyser.current : micAnalyser;
      const data = currentStatus === 'speaking' && outputData ? outputData : micData;
      if (analyser && data) {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let index = 0; index < data.length; index++) { const value = (data[index] - 128) / 128; sum += value * value; }
        const rms = Math.sqrt(sum / data.length);
        const level = Math.max(0, Math.min(1, (rms - .008) * 9));
        voiceLevel.current = level;
        const panel = voicePanel.current;
        if (panel) {
          panel.style.setProperty('--voice-level', level.toFixed(3));
          panel.style.setProperty('--voice-scale', (1 + level * .12).toFixed(3));
          panel.style.setProperty('--voice-glow', (.08 + level * .42).toFixed(3));
        }
        voiceButton.current?.style.setProperty('--voice-scale', (1 + level * .12).toFixed(3));
        if (currentStatus === 'listening' && rms > .024) beginRecording();
        else if (currentStatus === 'recording') {
          if (rms > .016) lastVoiceAt = Date.now();
          if (Date.now() - startedAt > 45000) finishRecording();
          else if (Date.now() - lastVoiceAt > 850) finishRecording();
        }
      }
      frame = requestAnimationFrame(measure);
    }
    const ended = () => { if (!stopped) { setVoiceError('Microphone disconnected. Restart voice to continue.'); updateVoiceStatus('error'); } };
    activeStream.getAudioTracks().forEach(track => track.addEventListener('ended', ended));
    setVoiceError(''); updateVoiceStatus('listening'); frame = requestAnimationFrame(measure);
    return () => {
      stopped = true; voiceSession.current++; cancelAnimationFrame(frame); activeStream.getAudioTracks().forEach(track => track.removeEventListener('ended', ended));
      if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
      micSource?.disconnect(); micAnalyser?.disconnect();
      voiceLevel.current = 0; voiceRequest.current?.abort();
      const audio = voiceAudio.current; if (audio) { audio.pause(); audio.onended = null; audio.onerror = null; audio.removeAttribute('src'); audio.load(); }
      window.speechSynthesis?.cancel(); voicePending.current = null;
      if (!voiceModeRef.current) updateVoiceStatus('off');
    };
  }, [voiceMode, voiceStream, conversationId]);
  useEffect(() => () => { voiceSession.current++; voiceRequest.current?.abort(); voiceContext.current?.close().catch(() => {}); }, []);
  const visibleMessages = messages.filter(m => !m.internal && (!messageQuery.trim() || m.content.toLowerCase().includes(messageQuery.trim().toLowerCase())));
  const activeJobs = jobs.filter(j => j.status === 'pending' || j.status === 'running' || j.status === 'cancel_requested');
  const fontFamily = font === 'serif' ? 'Georgia, serif' : font === 'system' ? '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' : '"Inter Variable", sans-serif';
  return <main className={`main-content ${draggingFiles ? 'files-dragging' : ''}`} style={{ fontFamily }} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDraggingFiles(true);}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDraggingFiles(false);}} onDrop={e=>{e.preventDefault();setDraggingFiles(false);if(!readingFiles && conversationId)void addFiles(e.dataTransfer.files);}}>
    <audio ref={voiceAudio} className="voice-audio" preload="none"/>
    {draggingFiles?<div className="file-drop-hint">Drop files into this conversation</div>:null}
    <header className="workspace-toolbar"><div className="toolbar-location"><strong>{title}</strong>{room?.is_group ? <span className="thread-subtitle">{room.bot_ids.length} agents</span> : null}</div><div className="toolbar-actions">{conversationId?<><button ref={searchTrigger} className="toolbar-button" aria-label="Search this conversation" aria-pressed={searchOpen} onClick={()=>{if(searchOpen)closeSearch();else setSearchOpen(true);}}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><span>Search</span></button><button className="toolbar-button thread-work-button" aria-label="Open conversation work" aria-expanded={workOpen} onClick={()=>setWorkOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M9 5V3h6v2M8 10h8m-8 5h5"/></svg>{activeJobs.length ? <span className="work-count">{activeJobs.length}</span> : null}</button>{!voiceMode?<button className="toolbar-button voice-toolbar-button" aria-label="Talk to Cypher" disabled={!conversationId} onClick={()=>void toggleVoice()}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/></svg><span>Talk</span></button>:null}</>:null}<details ref={settings} className="thread-settings"><summary aria-label="Conversation settings" title="Conversation settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-10v.01"/></svg></summary><div className="thread-settings-sheet"><h2>Conversation settings</h2>{room?.is_group ? <details className="thread-members"><summary><span className="thread-member-stack" aria-hidden="true">{roomMembers.slice(0,4).map(member=><BotAvatar key={member.id} name={member.name} small/>)}</span><span>{room.bot_ids.length} agents</span></summary><div className="team-members">{roomMembers.map(member=><span key={member.id} title={`${member.llmProvider} · ${member.llmModel}`}><BotAvatar name={member.name} small/>{member.name}</span>)}</div></details> : null}{bot ? <div className="conversation-computer"><span>{computerBotId === bot.id ? 'Computer connected' : 'Computer tools'}</span><button disabled={computerBusy} onClick={() => void toggleComputer()}>{computerBusy ? 'Connecting…' : computerBotId === bot.id ? 'Stop computer' : 'Start computer'}</button></div> : null}<RunControls options={options} onChange={setOptions} font={font} onFont={setFont} group={!!room?.is_group} model={bot ? { provider: bot.llmProvider, model: bot.llmModel } : undefined}/><button type="button" className="model-connection-link" onClick={() => onOpenSetup?.()}>Connect or test a model</button>    {jobs.length ? <details className="job-tray"><summary>{activeJobs.length ? `${activeJobs.length} job${activeJobs.length === 1 ? '' : 's'} in progress` : 'Recent work'}</summary>{jobs.slice(0,6).map(job => <div key={job.id}><span>{job.title}</span><strong data-status={job.status}>{job.status === 'cancel_requested' ? 'Stopping…' : job.status}</strong>{['pending','running'].includes(job.status) ? <button aria-label={`Cancel ${job.title}`} onClick={() => api.cancelJob(conversationId, job.id).catch(e => setError(e.message))}>Cancel</button> : null}</div>)}</details> : null}
    {conversationId ? <ContextPanel key={'context-'+conversationId} conversationId={conversationId}/> : null}

    <details className="thread-options"><summary>Message options <span>{options.output === 'image' ? 'Image' : 'Automatic'} · {options.routing!=='manual'?'Auto specialists':options.model}</span></summary><div className="output-controls"><label>Manager<GlassSelect aria-label="Manager model" value={options.routing!=='manual'?'auto':options.model || bot?.llmModel || 'gpt-6.1-sol'} onChange={e => { setOptions({...options,routing:e.target.value==='auto'?'auto':'manual',provider:MODEL_CHOICES.find(m=>m.model===e.target.value)?.provider||'openai',model:e.target.value==='auto'?'gpt-6.1-sol':e.target.value}); try { localStorage.setItem('grokbot-manager',e.target.value); } catch {} }}><option value="auto">Auto · task specialists</option>{MODEL_CHOICES.map(m=><option key={m.id} value={m.model}>{m.label}</option>)}</GlassSelect></label><label className="thread-tools-control"><input type="checkbox" checked={options.allow_tools!==false} onChange={event=>setOptions(current=>({...current,allow_tools:event.target.checked}))}/>Allow connected tools</label><label>Output<GlassSelect aria-label="Output type" value={options.output || 'text'} onChange={e => setOptions({ ...options, output: e.target.value as 'text' | 'image', aspect_ratio: '16:9' })}><option value="text">Automatic</option><option value="image">Create an image</option></GlassSelect></label>{options.output && options.output !== 'text' ? <><label>Shape<GlassSelect aria-label="Media shape" value={options.aspect_ratio || '16:9'} onChange={e => setOptions({ ...options, aspect_ratio: e.target.value })}><option value="16:9">Landscape</option><option value="9:16">Portrait</option>{options.output === 'image' ? <option value="1:1">Square</option> : null}</GlassSelect></label><span className="media-cost-note">Uses generation credits</span></> : null}</div></details>
</div></details></div></header>
    {searchOpen?<div className="conversation-search"><input autoFocus type="search" aria-label="Search loaded messages" placeholder="Search loaded messages…" value={messageQuery} onChange={event=>setMessageQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape')closeSearch();}}/><span role="status">{visibleMessages.length} results</span><button onClick={closeSearch}>Close</button></div>:null}
    {voiceMode?<section ref={voicePanel} className={`voice-console voice-${voiceStatus}`} aria-label="Cypher voice chat"><div className="voice-console-mark"><BinaryLens className="voice-binary-lens" active={voiceStatus!=='off'} levelSource={voiceLevel} label="Cypher voice activity"/></div><div className="voice-console-copy"><strong role="status" aria-live="polite">{VOICE_STATUS_LABEL[voiceStatus]}</strong><p>{voiceStatus==='listening'?'Say what you need. I’ll listen and take care of it.':voiceStatus==='recording'?'Listening to your request…':voiceStatus==='thinking'?'Working on your request now.':voiceStatus==='speaking'?'Here’s the answer.':voiceStatus==='error'?'Check the message below and try again.':'Voice chat is ready.'}</p>{voiceError?<span role="alert">{voiceError}</span>:null}</div><button type="button" className="voice-stop-button" onClick={onVoiceStop}>Stop talking</button></section>:null}
    {!voiceMode && voiceError ? <p className="voice-inline-error" role="alert">{voiceError}</p> : null}
    {conversationId?<WorkPanel open={workOpen} onClose={()=>setWorkOpen(false)} conversationId={conversationId} jobs={jobs} options={options} onChange={setOptions} onRefresh={async()=>setJobs(await api.getJobs(conversationId))}/>:null}
    {!bot && !room ? <QuickStart key={draftScope || 'local'} draftScope={draftScope} options={options} onOptions={setOptions} onStart={onQuickStart} onOpenRecent={onOpenRecent} onVoiceStart={onVoiceStart}/> : <>
    {bot ? <div className="conversation-computer"><span>{computerBotId === bot.id ? 'Computer connected' : 'Computer tools'}</span><button disabled={computerBusy} onClick={() => void toggleComputer()}>{computerBusy ? 'Connecting…' : computerBotId === bot.id ? 'Stop computer' : 'Start computer'}</button></div> : null}
    {room?.is_group ? <details className="thread-members"><summary><span className="thread-member-stack" aria-hidden="true">{roomMembers.slice(0, 4).map(member => <BotAvatar key={member.id} name={member.name} small/>)}</span><span>{room.bot_ids.length} teammates</span></summary><div className="team-members">{roomMembers.map(member => <span key={member.id} title={`${member.llmProvider} · ${member.llmModel}`}><BotAvatar name={member.name} small/>{member.name}</span>)}</div></details> : null}
    {computerError ? <p role="alert">{computerError}</p> : null}
    {error ? <div className="conversation-alert" role="alert"><span>{error.replace(/^Error: /, '')}</span><button aria-label="Dismiss error" onClick={() => setError('')}>Dismiss</button></div> : null}{syncError ? <div className="sync-status" role="status"><span>{syncError}</span>{sessionExpired?<a href="/login">Sign in</a>:<button disabled={refreshing || retryAt>Date.now()} onClick={()=>window.dispatchEvent(new Event('grokbot:refresh'))}>{refreshing?'Reconnecting…':retryAt>Date.now()?'Waiting to retry…':'Reconnect'}</button>}</div> : null}
    <div ref={stream} hidden={voiceMode} onScroll={() => { const el = stream.current; if (el) followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; setAwayFromLatest(!followLatest.current); }} className="message-stream" style={{ flex:1,overflowY:'auto',display:'flex',flexDirection:'column' }}>{hasEarlier ? <button className="load-earlier" disabled={loadingEarlier} onClick={loadEarlier}>{loadingEarlier ? 'Loading…' : 'Load earlier messages'}</button> : null}{messages.some(m => m.internal) ? <details className="fleet-activity"><summary>Background activity</summary>{messages.filter(m => m.internal).map(m => <MessageBubble key={m.id} message={m} bot={bots.find(b => b.id === m.senderBotId)}/>)}</details> : null}{visibleMessages.map((m,index) => {
        const previous = visibleMessages[index - 1];
        const next = visibleMessages[index + 1];
        const grouped = sameMessageGroup(previous, m);
        const currentTime = messageTime(m.createdAt);
        const previousTime = previous ? messageTime(previous.createdAt) : null;
        const showDate = !previous || !previousTime || previousTime.toDateString() !== currentTime.toDateString() || currentTime.getTime() - previousTime.getTime() >= 300000;
        return <React.Fragment key={m.id}>
          {showDate ? <div className="message-date"><time dateTime={m.createdAt}>{messageDateLabel(m.createdAt)}</time></div> : null}
          <MessageBubble message={m} onReply={message=>{setReplyTo(message);document.getElementById("message")?.focus();}} grouped={grouped} groupEnd={!sameMessageGroup(m, next)} showTimestamp={false} bot={bots.find(b => b.id === m.senderBotId)}/>
        </React.Fragment>;
      })}{!loading && messageQuery.trim() && !visibleMessages.length ? <div className="work-empty"><h3>No matching messages</h3><p>Try a different search. Only loaded messages are included.</p></div> : null}{loading ? <LoadingState label="Loading conversation…" variant="messages"/> : null}{!loading && !syncError && !error && !visibleMessages.length && !messageQuery.trim() ? <div className="conversation-empty"><strong>{room ? 'What should we take care of?' : 'What should I take care of?'}</strong><p>Send the outcome you want, or drop in a file.</p><span>Work continues in the cloud when you close this tab.</span></div> : null}</div>
    {awayFromLatest && !voiceMode ? <button className="jump-latest" onClick={() => { followLatest.current=true; setAwayFromLatest(false); stream.current?.scrollTo({top:stream.current.scrollHeight, behavior:document.documentElement.dataset.motion==='false' || window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}); }}>Jump to latest</button> : null}
    {activeJobs.length ? <div className="active-work" role="status"><span>{activeJobs.some(job => job.status === 'running') ? 'Working on your request' : activeJobs.some(job => job.status === 'cancel_requested') ? 'Stopping…' : 'Request queued'}{activeJobs.length > 1 ? ` · ${activeJobs.length} tasks` : ''}</span><button disabled={stopping || activeJobs.every(job => job.status === 'cancel_requested')} onClick={async () => { setStopping(true); const cancellable=activeJobs.filter(job => job.status !== 'cancel_requested'); const results=await Promise.allSettled(cancellable.map(job => api.cancelJob(conversationId,job.id))); if(results.some(result => result.status === 'rejected')) setError('Some work could not be stopped. Try again.'); setJobs(await api.getJobs(conversationId).catch(() => jobs)); setStopping(false); }}>Stop</button></div> : null}
    {attachments.length ? <div className="attachment-tray">{attachments.map((a,i) => <span key={`${a.name}-${i}`}>{a.mime.startsWith('image/') ? <img src={`data:${a.mime};base64,${a.data}`} alt=""/> : null}{a.name}<button aria-label={`Remove ${a.name}`} onClick={() => setAttachments(prev => prev.filter((_,index) => index !== i))}>Remove</button></span>)}</div> : null}
    {replyTo?<div className="reply-preview"><span>Replying in an isolated thread: {replyTo.content.slice(0,110)}</span><button onClick={()=>setReplyTo(null)}>Cancel reply</button></div>:null}
    <div className="composer"><input className="visually-hidden" ref={fileInput} type="file" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.json,.mp3,.wav,.m4a,.ogg,.flac,.mp4,.webm,.mov" onChange={e => void addFiles(e.target.files)}/><button className="attach-button" aria-label="Attach files" disabled={readingFiles || !conversationId} onClick={() => fileInput.current?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16"/></svg></button><label className="visually-hidden" htmlFor="message">Message {title}</label><textarea id="message" rows={1} maxLength={20000} value={input} placeholder={options.output==='image'?'Describe an image…':'Message'} onChange={e => { setInput(e.target.value); e.currentTarget.style.height="auto"; e.currentTarget.style.height=Math.min(e.currentTarget.scrollHeight,150)+"px"; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><button ref={voiceButton} type="button" className={`composer-voice-button${voiceMode?' is-active':''}`} aria-label={voiceMode?'Stop voice chat':'Start voice chat with Cypher'} aria-pressed={voiceMode} title={voiceMode?'Stop voice chat':'Talk to Cypher'} disabled={!conversationId&&!voiceMode} onClick={()=>void toggleVoice()}><CypherMark className="composer-voice-mark" decorative/><span className="composer-voice-label">{voiceMode?voiceStatus==='speaking'?'Speaking':voiceStatus==='thinking'?'Working':voiceStatus==='error'?'Voice issue':'Listening':'Voice'}</span></button><button className="send-button" aria-label="Send message" disabled={!conversationId || sending || readingFiles || (!input.trim() && !attachments.length)} onClick={()=>void send()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button></div>
    {readingFiles?<p className="input-note" role="status">Reading files…</p>:null}
    <p className="input-note visually-hidden">{options.output && options.output !== 'text' ? 'Media mode uses your text prompt. Choose Text to discuss attached files.' : 'Enter to send · Shift + Enter for a new line · Text drafts saved in this tab'}</p>
    </>}
  </main>;
}
