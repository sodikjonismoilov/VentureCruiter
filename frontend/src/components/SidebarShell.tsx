'use client';
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import CypherMark from './cipher/CypherMark';

const STORAGE_KEY = 'grokbot-sidebar-layout-v1';
const DEFAULT_WIDTH = 184;
const MIN_WIDTH = 176;
const MAX_WIDTH = 320;
const CHAT_MIN_WIDTH = 360;
const WIDTH_STEP = 16;
type Side = 'left' | 'right';
type Layout = { side: Side; width: number; collapsed: boolean };
const DEFAULT_LAYOUT: Layout = { side: 'left', width: DEFAULT_WIDTH, collapsed: false };
function clampWidth(width: number) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - CHAT_MIN_WIDTH, width));
}
const panelIcon = <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>;

export function SidebarShell({ children }: { children: ReactNode }) {
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [loaded, setLoaded] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [preview, setPreview] = useState<Side | null>(null);
  const [resizing, setResizing] = useState(false);
  const mobileDialog = useRef<HTMLDialogElement>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const dockStart = useRef<number | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved) setLayout({ side: saved.side === 'right' ? 'right' : 'left', width: Number.isFinite(saved.width) ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, saved.width)) : DEFAULT_WIDTH, collapsed: saved.collapsed === true });
    } catch {}
    setLoaded(true);
    const media = window.matchMedia('(max-width: 760px)');
    const resizeViewport = () => { setMobile(media.matches); if (!media.matches) setMobileOpen(false); };
    resizeViewport(); media.addEventListener('change', resizeViewport);
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !event.altKey && !event.shiftKey && !(event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable=true]'))) {
        event.preventDefault(); if (media.matches) setMobileOpen(value => !value); else setLayout(current => ({ ...current, collapsed: !current.collapsed }));
      }
    };
    const closeNavigation=()=>setMobileOpen(false);
    window.addEventListener('grokbot:navigate',closeNavigation);
    window.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('grokbot:navigate',closeNavigation); window.removeEventListener('keydown', shortcut); media.removeEventListener('change', resizeViewport); };
  }, []);
  useEffect(() => { if (loaded) try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch {} }, [layout, loaded]);
  useEffect(() => { if (mobileOpen) mobileDialog.current?.showModal(); else mobileDialog.current?.close(); }, [mobileOpen, mobile]);
  function resize(event: PointerEvent<HTMLDivElement>) {
    if (!resizeStart.current) return;
    const width = clampWidth(resizeStart.current.width + (event.clientX - resizeStart.current.x) * (layout.side === 'left' ? 1 : -1));
    setLayout(current => ({ ...current, width }));
  }
  function endResize() { resizeStart.current = null; setResizing(false); }
  function endDock(event: PointerEvent<HTMLButtonElement>) {
    if (dockStart.current !== null && Math.abs(event.clientX - dockStart.current) > WIDTH_STEP) setLayout(current => ({ ...current, side: event.clientX < window.innerWidth / 2 ? 'left' : 'right' }));
    dockStart.current = null; setPreview(null);
  }
  const tools = <div className="sidebar-layout-tools" aria-label="Navigation layout">
    <a className="sidebar-brand" href="/" aria-label="Cypher prospecting home"><CypherMark className="brand-symbol" decorative/><span>Cypher</span></a>
    <button aria-label={layout.collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!layout.collapsed} title="Toggle sidebar (⌘/Ctrl B)" onClick={() => setLayout(current => ({ ...current, collapsed: !current.collapsed }))}>{panelIcon}</button>

    <details className="sidebar-layout-menu"><summary aria-label="Sidebar layout options" title="Sidebar layout options"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></summary><div>
      <button className="sidebar-drag" onPointerDown={event => { if(event.button !== 0)return; dockStart.current=event.clientX; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if(dockStart.current !== null && Math.abs(event.clientX-dockStart.current)>WIDTH_STEP)setPreview(event.clientX<window.innerWidth/2?'left':'right'); }} onPointerUp={endDock} onPointerCancel={()=>{dockStart.current=null;setPreview(null);}}>Drag to either side</button>
      <button onClick={event => { setLayout(current => ({ ...current, side: current.side === 'left' ? 'right' : 'left' })); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Move sidebar {layout.side === 'left' ? 'right' : 'left'}</button>
      <button onClick={event => { setLayout(DEFAULT_LAYOUT); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Reset layout</button>
    </div></details>
  </div>;
  if (mobile) return <>
    <button className="mobile-menu-button" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}>{panelIcon}</button>
    <dialog ref={mobileDialog} className="mobile-navigation" aria-label="Workspace navigation" onCancel={() => setMobileOpen(false)} onClose={() => setMobileOpen(false)} onClick={event => { if (event.target === event.currentTarget) setMobileOpen(false); }}>
      <div className="mobile-nav-header"><strong><a href="/" aria-label="Cypher prospecting home"><CypherMark className="brand-symbol" decorative/>Cypher</a></strong><button aria-label="Close navigation" onClick={() => setMobileOpen(false)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
      <div className="mobile-nav-content" onClickCapture={event => { if ((event.target as HTMLElement).closest('.command-launcher,.bot-row,.workspace-name,.new-task-button,.cypher-primary-nav button,.cypher-recent-tasks button:not(.recent-task-retry),.preferences-nav,.plugins-nav,.workspace-primary-links button,.workspace-primary-links a,.workspace-label,.roster-toolbar button[aria-label="Create agent"],.rooms-label button')) { mobileDialog.current?.close(); setMobileOpen(false); } }}>{children}</div>
    </dialog>
  </>;
  return <section className="sidebar-shell" aria-label="Workspace sidebar" data-side={layout.side} data-collapsed={layout.collapsed} data-resizing={resizing} style={{ '--sidebar-width': `${layout.width}px` } as CSSProperties}>
    {tools}{children}
    {!layout.collapsed ? <div className="sidebar-resize-handle" role="separator" tabIndex={0} aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={Math.round(layout.width)} title="Drag to resize · double-click to reset" onDoubleClick={() => setLayout(current => ({ ...current, width: DEFAULT_WIDTH }))} onPointerDown={event => { if(event.button !== 0)return;resizeStart.current={x:event.clientX,width:event.currentTarget.parentElement!.getBoundingClientRect().width};setResizing(true);event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();}} onPointerMove={resize} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={event => { if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const delta=(event.key==='ArrowRight'?WIDTH_STEP:-WIDTH_STEP)*(layout.side==='left'?1:-1);setLayout(current=>({...current,width:clampWidth(event.key==='Home'?MIN_WIDTH:event.key==='End'?MAX_WIDTH:current.width+delta)})); }}/> : null}
    {preview ? <div className="sidebar-dock-preview" role="status" data-side={preview}>Release to dock {preview}</div> : null}
  </section>;
}
