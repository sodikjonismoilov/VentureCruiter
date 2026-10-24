'use client';

import { useCallback, useEffect, useState } from 'react';
import { request } from '../../lib/api';
import { LoadingState } from '../LoadingState';
import styles from './RecentWork.module.css';

interface RecentRun {
  id: string;
  title: string;
  status: string;
  conversation_id: string;
  created_at: string;
}

function relativeDate(value: string) {
  const timestamp = new Date(value.endsWith('Z') ? value : `${value}Z`).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
}

export function RecentWork({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const [runs, setRuns] = useState<RecentRun[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await request('/workspace/runs') as RecentRun[];
      setRuns(data.slice(0, 3));
    } catch {
      setError('Recent work could not load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className={styles.recentWork} aria-labelledby="recent-work-heading" aria-busy={loading}>
      <div className={styles.headingRow}>
        <h2 id="recent-work-heading">
          Recent work
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>
        </h2>
      </div>
      {loading ? <LoadingState label="Loading recent work…" variant="recent"/> : error ? (
        <div className={styles.errorRow} role="status">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} disabled={loading}>Retry</button>
        </div>
      ) : !runs.length ? <p className={styles.empty}>Your recent tasks will appear here.</p> : (
        <div className={styles.runList}>
          {runs.map((run, index) => (
            <button
              key={run.id}
              type="button"
              className={styles.run}
              style={{ animationDelay: `${index * 45}ms` }}
              onClick={() => onOpen(run.conversation_id)}
            >
              <span className={styles.runTitle}>{run.title || 'Untitled task'}</span>
              <span className={styles.runMeta}>{run.status.replaceAll('_', ' ')} · {relativeDate(run.created_at)}</span>
              <svg className={styles.arrow} viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10m-4-4 4 4-4 4" /></svg>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
