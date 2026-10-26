import { useEffect, useState } from 'react';
import { AccountMenu } from './AccountMenu';
import { LoadingState } from './LoadingState';
import { Bot, Conversation } from '../lib/types';
import { BotAvatar } from './BotAvatar';
import { request } from '../lib/api';
import type { WorkspacePreferences } from './WorkspaceHub';

type RecentRun = { id: string; title: string; status: string; conversation_id: string; created_at: string };

export function BotRoster({ bots, selectedBot, onSelectBot, onCreateNew, rooms, selectedRoom, onSelectRoom, onCreateRoom, onHome, onSetup, onPlugins, onPreferences, onGoals, onChannels, onWorkspace, onMyWork, onOpenRecent, onComputer, accountEmail, activeView = 'home', loadingAgents = false, loadingRooms = false, agentsError = false, roomsError = false }: { activeView?: string; loadingAgents?: boolean; loadingRooms?: boolean; agentsError?: boolean; roomsError?: boolean; onWorkspace:()=>void; onMyWork:()=>void; onOpenRecent:(id:string)=>void; onComputer:()=>void; accountEmail?: string; bots: Bot[]; selectedBot: Bot | null; onSelectBot: (bot: Bot) => void; onCreateNew: () => void; rooms: Conversation[]; selectedRoom: Conversation | null; onSelectRoom: (room: Conversation) => void; onCreateRoom: () => void; onHome: () => void; onSetup: () => void; onPlugins: () => void; onPreferences: () => void; onGoals: () => void; onChannels: () => void }) {
  const [prefs, setPrefs] = useState<WorkspacePreferences>({});
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);
  const [pinsLoaded, setPinsLoaded] = useState(false);
  const [onlyWorking, setOnlyWorking] = useState(false);
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [showAllRooms, setShowAllRooms] = useState(false);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [recentRunsLoading, setRecentRunsLoading] = useState(true);
  const [recentRunsUnavailable, setRecentRunsUnavailable] = useState(false);
  const [recentRunsRetry, setRecentRunsRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () => {
      void request('/workspace/settings').then(data => { if (active) setPrefs(data); }).catch(() => {});
    };
    load();
    window.addEventListener('grokbot:preferences', load);
    return () => { active = false; window.removeEventListener('grokbot:preferences', load); };
  }, []);

  useEffect(() => {
    let active = true;
    setRecentRunsLoading(true);
    void request('/workspace/runs').then((data: RecentRun[]) => {
      if (active) { setRecentRuns(Array.isArray(data) ? data.slice(0, 5) : []); setRecentRunsUnavailable(false); }
    }).catch(() => { if (active) setRecentRunsUnavailable(true); }).finally(() => {
      if (active) setRecentRunsLoading(false);
    });
    return () => { active = false; };
  }, [recentRunsRetry]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('grokbot-pinned-agents-v1') || '[]');
      if (Array.isArray(saved)) setPinned(saved.filter((id: unknown): id is string => typeof id === 'string').slice(0, 100));
    } catch {}
    setPinsLoaded(true);
  }, []);
  useEffect(() => {
    if (pinsLoaded) try { localStorage.setItem('grokbot-pinned-agents-v1', JSON.stringify(pinned)); } catch {}
  }, [pinned, pinsLoaded]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleBots = bots
    .filter(bot => !prefs.hidden_bots?.includes(bot.id)
      && (!onlyWorking || bot.status === 'working')
      && [bot.name, bot.role, bot.description].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery))
    .sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id))
      || (Object.entries(prefs.bot_sections || {}).find(([, ids]) => ids.includes(a.id))?.[0] || 'Agents')
        .localeCompare(Object.entries(prefs.bot_sections || {}).find(([, ids]) => ids.includes(b.id))?.[0] || 'Agents'));
  const previewBots = visibleBots.slice(0, 3);
  if (selectedBot && visibleBots.some(bot => bot.id === selectedBot.id) && !previewBots.some(bot => bot.id === selectedBot.id)) {
    previewBots.splice(previewBots.length - 1, 1, selectedBot);
  }
  const renderedBots = searching && normalizedQuery || showAllAgents ? visibleBots : previewBots;
  const hiddenAgentCount = visibleBots.length - previewBots.length;
  const showAgentToggle = (!searching || !normalizedQuery) && (hiddenAgentCount > 0 || showAllAgents);
  const visibleRooms = rooms.filter(room => room.title.toLowerCase().includes(normalizedQuery));
  const previewRooms = visibleRooms.slice(0, 1);
  if (selectedRoom && visibleRooms.some(room => room.id === selectedRoom.id) && !previewRooms.some(room => room.id === selectedRoom.id)) {
    previewRooms.splice(0, 1, selectedRoom);
  }
  const renderedRooms = searching && normalizedQuery || showAllRooms ? visibleRooms : previewRooms;
  const showRoomToggle = (!searching || !normalizedQuery) && (visibleRooms.length > previewRooms.length || showAllRooms);

  return <aside className="sidebar">
    <button className="new-task-button" aria-current={activeView === 'home' ? 'page' : undefined} onClick={onHome} title="New task">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>New task</span>
    </button>

    <nav className="cypher-primary-nav" aria-label="Main navigation">
      <button aria-current={activeView === 'work' ? 'page' : undefined} onClick={onMyWork}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8m-8 4h5"/></svg><span>My work</span></button>
      <button aria-current={activeView === 'apps' ? 'page' : undefined} onClick={onPlugins}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v3"/></svg><span>Apps</span></button>
      <button aria-current={activeView === 'saved' ? 'page' : undefined} onClick={onWorkspace}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H19v18H8.5A2.5 2.5 0 0 0 6 22V4.5Zm0 0A2.5 2.5 0 0 0 3.5 2H3v18h5.5A2.5 2.5 0 0 1 11 22"/></svg><span>Saved</span></button>
      <button aria-current={activeView === 'settings' ? 'page' : undefined} onClick={onSetup}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 14 5l2.5-.2.9 2.3 2.1 1.4-.6 2.5.6 2.5-2.1 1.4-.9 2.3L14 17l-2 1.5L10 17l-2.5.2-.9-2.3-2.1-1.4.6-2.5-.6-2.5 2.1-1.4.9-2.3L10 5l2-1.5Z"/><circle cx="12" cy="11.5" r="2.5"/></svg><span>Settings</span></button>
    </nav>

    <section className="cypher-recent-tasks" aria-labelledby="cypher-recent-tasks-title" aria-busy={recentRunsLoading}>
      <h2 id="cypher-recent-tasks-title">Recent tasks</h2>
      {recentRunsLoading ? <p role="status">Loading recent tasks…</p> : recentRunsUnavailable ? <><p role="status">Recent tasks are unavailable.</p><button type="button" className="recent-task-retry" onClick={() => { setRecentRunsUnavailable(false); setRecentRunsLoading(true); setRecentRunsRetry(count => count + 1); }}>Retry</button></> : recentRuns.length ? recentRuns.map(run => <button key={run.id} title={run.title || 'Untitled task'} onClick={() => onOpenRecent(run.conversation_id)}><span className="cypher-task-dot" aria-hidden="true"/><span>{run.title || 'Untitled task'}</span></button>) : <p>No recent tasks yet.</p>}
    </section>

    <details className="cypher-team-disclosure">
      <summary>Agents &amp; teams</summary>

    {searching ? <input autoFocus aria-label="Search agents and rooms" placeholder="Find an agent, role, or room…" value={query} onChange={event => setQuery(event.target.value)} className="search-input" onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearching(false); } }} /> : null}

    <header className="roster-toolbar">
      <span className="section-label">Agents</span>
      <button className="round-button" aria-label="Search agents and rooms" aria-expanded={searching} onClick={() => { setSearching(value => !value); setQuery(''); }}>
        <svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/></svg>
      </button>
      <button className="round-button" aria-label="Create agent" onClick={onCreateNew}>
        <svg viewBox="0 0 24 24"><path d="M12 4v16M4 12h16"/></svg>
      </button>
    </header>

    <details className="roster-filter-details">
      <summary aria-label="Filter agents" title="Filter agents"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6.5 7.2v5.5l-3 1.6v-7.1L4 5Z"/></svg></summary>
      <div className="roster-filters" aria-label="Filter agents">
        <button aria-pressed={!onlyWorking} onClick={() => setOnlyWorking(false)}>All</button>
        <button aria-pressed={onlyWorking} onClick={() => setOnlyWorking(value => !value)}>Working <span>{bots.filter(bot => bot.status === 'working').length}</span></button>
      </div>
    </details>

    <nav className="roster-list" aria-label="Agents and team rooms">
      {loadingAgents && !bots.length ? <LoadingState label="Loading your agents…" variant="roster"/> : null}
      {renderedBots.map((bot, index) => <div className="agent-roster-item" key={bot.id}>
        {(() => {
          const section = Object.entries(prefs.bot_sections || {}).find(([, ids]) => ids.includes(bot.id))?.[0];
          const prior = Object.entries(prefs.bot_sections || {}).find(([, ids]) => ids.includes(visibleBots[index - 1]?.id))?.[0];
          return section && section !== prior ? <div className="agent-section-label">{section}</div> : null;
        })()}
        <button aria-label={bot.name} aria-current={selectedBot?.id === bot.id ? 'page' : undefined} title={[bot.name, bot.description || bot.role].filter(Boolean).join(' · ')} className={`bot-row ${selectedBot?.id === bot.id ? 'selected' : ''}`} onClick={() => onSelectBot(bot)}>
          <BotAvatar name={bot.name} agentRole={bot.role} status={bot.status === 'working' ? 'working' : undefined}/><span className="bot-row-text"><strong>{bot.name}</strong><span>{bot.status === 'working' ? 'Working…' : bot.description || bot.role}</span></span>
        </button>
        <button className="pin-agent" aria-label={`${pinned.includes(bot.id) ? 'Unpin' : 'Pin'} ${bot.name}`} aria-pressed={pinned.includes(bot.id)} title={`${pinned.includes(bot.id) ? 'Unpin' : 'Pin'} ${bot.name}`} onClick={() => setPinned(current => current.includes(bot.id) ? current.filter(id => id !== bot.id) : [...current, bot.id])}>
          <svg viewBox="0 0 24 24"><path d="m8 3 8 0-1 6 4 4v2H5v-2l4-4-1-6Zm4 12v7"/></svg>
        </button>
      </div>)}
      {bots.length && !visibleBots.length ? <p className="roster-no-results">{onlyWorking ? 'No matching agents are working.' : 'No matching agents.'}</p> : null}
      {showAgentToggle ? <button className="roster-show-all" onClick={() => setShowAllAgents(value => !value)}>{showAllAgents ? 'Show fewer' : `Show all ${visibleBots.length} agents`}</button> : null}
      {!loadingAgents && !agentsError && !bots.length ? <div className="roster-empty">Your team starts here.<button onClick={onCreateNew}>Create your first agent</button></div> : null}

      <div className="section-label rooms-label"><span>Team rooms</span><button aria-label="Create team room" onClick={onCreateRoom}>New</button></div>
      {loadingRooms && !rooms.length ? <LoadingState label="Loading your team rooms…" variant="roster" rows={1}/> : null}
      {renderedRooms.map(room => <button aria-label={room.title} aria-current={selectedRoom?.id === room.id ? 'page' : undefined} title={room.title} key={room.id} className={`bot-row ${selectedRoom?.id === room.id ? 'selected' : ''}`} onClick={() => onSelectRoom(room)}>
        <span className="room-avatar"><svg viewBox="0 0 24 24"><path d="M4 7h16v12H4zM7 3v4m10-4v4M8 11h8m-8 4h5"/></svg></span>
        <span className="bot-row-text"><strong>{room.title === 'Agent lounge' ? 'Your team' : room.title}</strong><span>{room.bot_ids.length} agents · shared context</span></span>
      </button>)}
      {showRoomToggle ? <button className="roster-show-all rooms-show-all" onClick={() => setShowAllRooms(value => !value)}>{showAllRooms ? 'Show fewer rooms' : `Show all ${visibleRooms.length} rooms`}</button> : null}
      {!loadingRooms && normalizedQuery && !visibleRooms.length ? <p className="roster-no-results">No matching rooms.</p> : null}
      {!loadingRooms && !roomsError && !rooms.length ? <p className="roster-no-results">No team rooms yet.</p> : null}
    </nav>
    </details>
    <details className="sidebar-more">
      <summary>More</summary>
      <div className="sidebar-more-content">
        <nav className="workspace-destinations" aria-label="Workspace tools">
          <a className="preferences-nav" href="/prospecting" aria-label="Prospecting"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4M8 10.5h5m-2.5-2.5v5"/></svg><span>Prospecting</span></a>
          <button className="preferences-nav" onClick={onComputer} aria-label="Computer"><svg viewBox="0 0 24 24"><path d="M3 4h18v13H3zM8 21h8m-4-4v4"/></svg><span>Computer</span></button>
          <button className="preferences-nav" onClick={onWorkspace} aria-label="Workspace library"><svg viewBox="0 0 24 24"><path d="M4 4h6v16H4zM14 4h6v16h-6z"/></svg><span>Memory, skills &amp; routines</span></button>
          <button className="preferences-nav" onClick={onGoals} aria-label="Goals"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="m12 12 8-8"/></svg><span>Goals</span></button>
        </nav>
        <nav className="workspace-tools" aria-label="Tools and settings">
          <button className="preferences-nav" onClick={onChannels} aria-label="Channels"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4V5Z"/></svg><span>Channels</span></button>
          <button className="preferences-nav" onClick={onPreferences} aria-label="Appearance"><svg viewBox="0 0 24 24"><path d="M5 4v16M12 4v16M19 4v16M2 8h6m1 8h6m1-6h6"/></svg><span>Appearance</span></button>
        </nav>
      </div>
    </details>

    <footer className="roster-footer">
      <AccountMenu accountEmail={accountEmail} onSetup={onSetup}/>
    </footer>
  </aside>;
}
