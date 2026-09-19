// Reading settings.
//
// Typography is the whole product here -- the text is someone else's and the
// only thing we control is how comfortably it reads. Everything is applied as
// CSS custom properties so a change costs one style recalculation rather than
// a re-render of the chapter.
//
// Stored in localStorage: it is a per-viewer convenience, and losing it in a
// private window is harmless.

import { el } from '../core/dom.js';

const KEY = 'pdr:reading';

const DEFAULTS = {
  fontSize: 19,
  lineHeight: 1.65,
  measure: 34, // characters-per-line, roughly, via `em` width
  family: 'serif',
  theme: 'auto',
};

const FAMILIES = {
  serif: 'ui-serif, Georgia, "Iowan Old Style", Palatino, serif',
  sans: 'ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage disabled; the settings still apply for this session.
  }
}

export function applySettings(s) {
  const root = document.documentElement;
  root.style.setProperty('--reading-size', `${s.fontSize}px`);
  root.style.setProperty('--reading-leading', String(s.lineHeight));
  root.style.setProperty('--reading-measure', `${s.measure}em`);
  root.style.setProperty('--reading-family', FAMILIES[s.family] ?? FAMILIES.serif);
  // `auto` means defer to the system, so the attribute is removed entirely.
  if (s.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', s.theme);
}

export function settingsPanel(settings, onChange) {
  const current = { ...settings };
  const update = (key, value) => {
    current[key] = value;
    onChange({ ...current });
  };

  return el('div', { className: 'panel' }, [
    slider('Size', current.fontSize, 15, 30, 1, (v) => update('fontSize', v), (v) => `${v}px`),
    slider('Spacing', current.lineHeight, 1.3, 2.2, 0.05, (v) => update('lineHeight', v), (v) => v.toFixed(2)),
    slider('Width', current.measure, 22, 48, 1, (v) => update('measure', v), (v) => `${v}em`),
    choice('Typeface', ['serif', 'sans', 'mono'], current.family, (v) => update('family', v)),
    choice('Theme', ['auto', 'light', 'sepia', 'dark'], current.theme, (v) => update('theme', v)),
  ]);
}

function slider(label, value, min, max, step, onInput, format) {
  const readout = el('span', { className: 'readout', textContent: format(value) });
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    oninput: (e) => {
      const v = Number(e.target.value);
      readout.textContent = format(v);
      onInput(v);
    },
  });
  return el('label', { className: 'control' }, [
    el('span', { className: 'control-label' }, [document.createTextNode(label), readout]),
    input,
  ]);
}

function choice(label, options, value, onPick) {
  const group = el('div', { className: 'choices' });
  const buttons = options.map((option) =>
    el('button', {
      type: 'button',
      textContent: option,
      className: option === value ? 'active' : '',
      onclick: () => {
        for (const b of buttons) b.className = '';
        group.querySelector(`[data-option="${option}"]`).className = 'active';
        onPick(option);
      },
      dataset: { option },
    }),
  );
  group.append(...buttons);
  return el('label', { className: 'control' }, [
    el('span', { className: 'control-label', textContent: label }),
    group,
  ]);
}
