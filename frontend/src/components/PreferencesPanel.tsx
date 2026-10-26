import { useEffect, useRef, useState } from 'react';
import { GlassSelect } from './GlassSelect';

type AppearanceTheme = 'system' | 'light' | 'dark';

export interface Appearance {
  accent: string;
  fontSize: number;
  width: number;
  density: string;
  motion: boolean;
  theme: AppearanceTheme;
}

export const DEFAULT_APPEARANCE: Appearance = {
  accent: '#1d1d1f',
  fontSize: 16,
  width: 88,
  density: 'comfortable',
  motion: true,
  theme: 'system',
};

function isAppearanceTheme(theme: unknown): theme is AppearanceTheme {
  return theme === 'system' || theme === 'light' || theme === 'dark';
}

function readAppearance(): Appearance {
  try {
    const saved = {
      ...DEFAULT_APPEARANCE,
      ...JSON.parse(localStorage.getItem('grokbot-appearance') || '{}'),
    } as Appearance;

    return {
      ...saved,
      accent: DEFAULT_APPEARANCE.accent,
      theme: isAppearanceTheme(saved.theme) ? saved.theme : 'system',
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function applyAppearance(value: Appearance) {
  const root = document.documentElement;
  root.style.removeProperty('--accent-blue');
  root.style.removeProperty('--focus-color');
  root.style.setProperty('--chat-font-size', `${value.fontSize}px`);
  root.style.setProperty('--message-width', `${value.width}%`);
  root.style.colorScheme = value.theme === 'system' ? '' : value.theme;

  if (value.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = value.theme;

  root.dataset.density = value.density;
  root.dataset.motion = String(value.motion);
}

export function restoreAppearance() {
  applyAppearance(readAppearance());
}

export function PreferencesPanel({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(DEFAULT_APPEARANCE);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    setValue(readAppearance());
    return () => {
      dialog.current?.close();
      previous?.focus();
    };
  }, []);

  function update(next: Appearance) {
    setValue(next);
    applyAppearance(next);
    try {
      localStorage.setItem('grokbot-appearance', JSON.stringify(next));
    } catch {
      // Keep the current session's appearance when browser storage is unavailable.
    }
  }

  return (
    <dialog
      ref={dialog}
      className="bot-dialog preferences-dialog"
      onCancel={onClose}
      aria-labelledby="appearance-title"
    >
      <h2 id="appearance-title">Appearance</h2>
      <p className="dialog-intro">Changes apply immediately and stay on this browser.</p>
      <div className="agent-form">
        <div className="agent-form-fields">
          <label htmlFor="color-scheme">Color scheme</label>
          <GlassSelect
            id="color-scheme"
            value={value.theme}
            onChange={event => update({ ...value, theme: event.target.value as AppearanceTheme })}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </GlassSelect>

          <label htmlFor="density">Agent list density</label>
          <GlassSelect
            id="density"
            value={value.density}
            onChange={event => update({ ...value, density: event.target.value })}
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
            <option value="spacious">Spacious</option>
          </GlassSelect>

          <label>
            Message text <output>{value.fontSize}px</output>
            <input
              aria-label="Message text size"
              type="range"
              min="14"
              max="22"
              value={value.fontSize}
              onChange={event => update({ ...value, fontSize: Number(event.target.value) })}
            />
          </label>

          <label>
            Desktop message width <output>{value.width}%</output>
            <input
              aria-label="Message width"
              type="range"
              min="60"
              max="100"
              value={value.width}
              onChange={event => update({ ...value, width: Number(event.target.value) })}
            />
          </label>

          <label className="check-row">
            <input
              type="checkbox"
              checked={value.motion}
              onChange={event => update({ ...value, motion: event.target.checked })}
            />
            Interface animations
          </label>
        </div>

        <div className="dialog-actions">
          <button className="btn-secondary" type="button" onClick={() => update(DEFAULT_APPEARANCE)}>
            Reset appearance
          </button>
          <button className="btn-primary" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
