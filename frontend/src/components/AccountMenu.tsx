'use client';

import styles from './AccountMenu.module.css';

const person = <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>;
const settings = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/><circle cx="12" cy="12" r="5"/></svg>;

export function AccountMenu({ accountEmail, onSetup }: { accountEmail?: string; onSetup: () => void }) {
  if (!accountEmail) return <div className={`${styles.account} ${styles.guest}`}>
    <a className={styles.signIn} href="/login" title="Sign in to Cypher">
      <span className={styles.avatar}>{person}</span><span className={styles.label}>Sign in</span>
    </a>
    <button className={`${styles.settings} workspace-label`} type="button" aria-label="Workspace setup" title="Workspace settings" onClick={onSetup}>{settings}</button>
  </div>;

  return <details className={styles.account} onToggle={event => {
    const details = event.currentTarget;
    if (event.target !== details) return;
    const menu = details.querySelector<HTMLElement>('nav');
    if (!details.open) { menu?.hidePopover(); return; }
    const rect = details.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 24);
    details.style.setProperty('--account-menu-left', `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`);
    details.style.setProperty('--account-menu-bottom', `${Math.max(12, window.innerHeight - rect.top + 8)}px`);
    menu?.showPopover();
  }} onKeyDown={event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  }}>
    <summary className={styles.trigger} aria-label={`Account: ${accountEmail}`} title={accountEmail}>
      <span className={styles.avatar} aria-hidden="true">{accountEmail.slice(0, 1).toUpperCase()}</span>
      <span className={styles.label}><strong>Account</strong><small>{accountEmail}</small></span>
      <svg className={styles.chevron} viewBox="0 0 24 24" aria-hidden="true"><path d="m8 14 4-4 4 4"/></svg>
    </summary>
    <nav className={styles.menu} aria-label="Account actions" ref={node => { node?.setAttribute('popover', 'auto'); }} onToggle={event => {
      if (!event.currentTarget.matches(':popover-open')) event.currentTarget.closest('details')?.removeAttribute('open');
    }}>
      <p>Signed in as <strong>{accountEmail}</strong></p>
      <button className="preferences-nav" type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onSetup(); }}>Workspace settings</button>
      <a href="/api/auth/logout">Switch account</a>
      <a href="/api/auth/logout">Sign out</a>
    </nav>
  </details>;
}
