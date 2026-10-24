'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { request } from '../lib/api';
import { SidebarShell } from './SidebarShell';
import CypherMark from './cipher/CypherMark';
import './workflow-shell.css';

interface RecentTask { id: string; title: string; conversation_id: string }

const destinations = [
  { label: 'New task', href: '/', path: 'M12 5v14M5 12h14' },
  { label: 'My work', href: '/?view=work', path: 'M5 5h14v14H5zM9 4v3m6-3v3m-6 5 2 2 4-4' },
  { label: 'Apps', href: '/?plugins=1', path: 'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z' },
  { label: 'Saved', href: '/?view=saved', path: 'M6 4h12v17l-6-4-6 4z' },
  { label: 'Settings', href: '/?view=settings', path: 'M5 6h14M5 12h14M5 18h14M9 4v4m6 2v4m-6 2v4' },
];

export default function WorkflowShell({ children, section }: { children: ReactNode; section: 'companies' | 'investors' }) {
  const [recent, setRecent] = useState<RecentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    request('/workspace/runs', { signal: controller.signal }).then((rows: RecentTask[]) => {
      if (!Array.isArray(rows)) throw new Error('Recent tasks are unavailable.');
      if (!controller.signal.aborted) setRecent(rows.filter(row => row.conversation_id).slice(0, 6));
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [retry]);

  return <div className="app-layout workflow-shell">
    <div className="workflow-window-chrome" aria-hidden="true"><span/><span/><span/></div>
    <SidebarShell>
      <aside className="sidebar workflow-navigation">
        <nav aria-label="Main navigation">{destinations.map(item => <a key={item.label} className="workflow-nav-link" href={item.href} onClick={() => window.dispatchEvent(new Event('grokbot:navigate'))}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.path}/></svg><span>{item.label}</span>
        </a>)}</nav>
        <section className="workflow-recent" aria-labelledby="workflow-recent-title" aria-busy={loading}>
          <h2 id="workflow-recent-title">Recent tasks</h2>
          {loading ? <p role="status">Loading recent tasks…</p> : failed ? <div className="workflow-recent-error"><p>Recent tasks couldn’t load.</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div> : recent.length ? recent.map(task => <a key={task.id} href={`/?conversation=${encodeURIComponent(task.conversation_id)}`} title={task.title}>{task.title || 'Untitled task'}</a>) : <p>Your recent tasks appear here.</p>}
        </section>
      </aside>
    </SidebarShell>
    <div className="workspace-main workflow-main">
      <header className="workflow-mobile-brand"><a href="/" aria-label="Cypher home"><CypherMark decorative/><span>Cypher</span></a></header>
      <nav className="workflow-sections" aria-label="Research workspace">
        <a href="/prospecting" aria-current={section === 'companies' ? 'page' : undefined}>Company research</a>
        <a href="/prospecting/investors" aria-current={section === 'investors' ? 'page' : undefined}>VC intelligence</a>
      </nav>
      <div className="workflow-content">{children}</div>
    </div>
  </div>;
}
