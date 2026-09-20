// The reader.
//
// Renders one chapter at a time. Moby-Dick is 9,000 sentences across 132
// chapters, and putting all of it in the DOM makes scrolling stutter on a
// phone for no benefit -- nobody reads two chapters at once.
//
// Every sentence is rendered as its own span carrying the id the pipeline
// assigned it. Nothing uses that yet; it is what the speech engine will
// highlight against, and retrofitting it later would mean re-rendering the
// whole book.

import { el } from '../core/dom.js';
import { loadSettings, saveSettings, applySettings, settingsPanel } from './settings.js';
import { createPlayer, playerBar } from './player.js';

const progressKey = (slug) => `pdr:progress:${slug}`;

let state = null;

export function unmount() {
  removeEventListener('keydown', onKey);
  document.documentElement.removeAttribute('style');
  state?.player?.destroy();
  state = null;
}

export async function mount(root, slug) {
  const res = await fetch(`/books/${encodeURIComponent(slug)}/book.json`);
  if (!res.ok) throw new Error(`that book is not in your library (${res.status})`);
  const book = await res.json();

  const settings = loadSettings();
  applySettings(settings);

  state = { slug, book, settings, chapter: restoreChapter(slug, book) };

  const article = el('article', { className: 'prose' });
  const title = el('span', { className: 'chapter-title' });

  const picker = chapterPicker(book, (i) => go(i));

  const bar = el('div', { className: 'bar' }, [
    el('a', { className: 'icon', href: '#/library', textContent: '‹ Library', title: 'Back to library' }),
    title,
    el('div', { className: 'bar-actions' }, [
      picker,
      el('button', {
        className: 'icon',
        textContent: 'Aa',
        title: 'Reading settings',
        onclick: () => panel.classList.toggle('open'),
      }),
    ]),
  ]);

  const panel = settingsPanel(state.settings, (next) => {
    state.settings = next;
    applySettings(next);
    saveSettings(next);
  });

  const nav = el('div', { className: 'chapter-nav' }, [
    el('button', { textContent: '← Previous', onclick: () => go(state.chapter - 1) }),
    el('button', { textContent: 'Next →', onclick: () => go(state.chapter + 1) }),
  ]);

  const transport = playerBar({
    onToggle: () => state.player.toggle(),
    onStep: (d) => state.player.step(d),
    onRate: (r) => {
      state.player.rate = r;
      renderPlayerStatus({ available: true, playing: state.player.playing });
    },
  });

  const player = createPlayer({ slug, article, onStatus: renderPlayerStatus });
  state.player = player;

  // Tapping a sentence starts the voice there -- the most useful way to move
  // around a recording, and only possible because the sync map is exact.
  article.addEventListener('click', (event) => {
    const span = event.target.closest?.('.sentence');
    if (span) state.player.seekToSentence(span.dataset.sid);
  });

  root.append(bar, panel, transport.element, article, nav);
  state.el = { article, title, nav, picker, transport };

  go(state.chapter, { restoreScroll: true });
  addEventListener('keydown', onKey);

  // Discovering the render is not worth blocking the text on.
  player.load().then(() => bindAudio());
}

function bindAudio() {
  if (!state?.player?.render) {
    renderPlayerStatus({ available: false });
    return;
  }
  state.player.setChapter(state.chapter);
}

function renderPlayerStatus(status) {
  const transport = state?.el?.transport;
  if (!transport) return;

  transport.setPlaying(Boolean(status.playing));
  transport.setEnabled(Boolean(status.available));

  if (!status.available) {
    transport.status.textContent = state?.player?.render
      ? 'this chapter has not been rendered'
      : 'no audio yet — render it with tts/render.py';
    return;
  }

  // Two multipliers stack: the speed baked in at synthesis, and the playback
  // rate applied on top. What matters to a listener is the product.
  const render = state.player.render;
  const total = (render.effectiveSpeed ?? render.speed) * state.player.rate;
  transport.status.textContent = `${render.voice} · ${total.toFixed(2)}× overall`;
}

// ------------------------------------------------------------------ rendering

function go(index, { restoreScroll = false } = {}) {
  const { book, el: nodes } = state;
  const clamped = Math.max(0, Math.min(index, book.chapters.length - 1));
  state.chapter = clamped;

  const chapter = book.chapters[clamped];
  nodes.title.textContent = chapter.title ?? book.title ?? '';

  // A run of separator rows is one scene break, so only the first is drawn.
  const blocks = chapter.blocks.filter(
    (block, i) => block.type !== 'break' || chapter.blocks[i - 1]?.type !== 'break',
  );

  nodes.article.replaceChildren(
    ...(chapter.title ? [el('h1', { textContent: chapter.title })] : []),
    ...blocks.map(renderBlock),
  );

  // Keep the picker in step when navigation came from the arrows or keyboard.
  nodes.picker.value = String(clamped);

  const [prev, next] = nodes.nav.children;
  prev.disabled = clamped === 0;
  next.disabled = clamped === book.chapters.length - 1;

  const saved = restoreScroll ? readProgress(state.slug)?.scroll ?? 0 : 0;
  scrollTo({ top: saved, behavior: 'instant' });
  writeProgress();

  if (state.player?.render) bindAudio();
}

function renderBlock(block) {
  // A scene break is drawn, not typeset.
  if (block.type === 'break') return el('hr', { className: 'scene-break' });

  const node = el('p', { className: block.type === 'verse' ? 'verse' : 'para' });

  block.sentences.forEach((sentence, i) => {
    node.append(
      el('span', {
        className: 'sentence',
        textContent: sentence.text,
        dataset: { sid: sentence.id },
      }),
    );

    // Verse keeps its line breaks; prose gets ordinary spacing.
    if (block.type === 'verse' && i < block.sentences.length - 1) node.append(el('br'));
    else node.append(document.createTextNode(' '));
  });

  return node;
}

function chapterPicker(book, onPick) {
  const select = el('select', {
    className: 'chapters',
    title: 'Chapters',
    onchange: (e) => onPick(Number(e.target.value)),
  });
  book.chapters.forEach((c, i) => {
    select.append(el('option', { value: String(i), textContent: c.title ?? `Chapter ${i + 1}` }));
  });
  return select;
}

// ------------------------------------------------------------------- progress

function restoreChapter(slug, book) {
  const saved = readProgress(slug);
  if (saved && saved.chapter < book.chapters.length) return saved.chapter;
  // Open at the first real chapter rather than the title page.
  const first = book.chapters.findIndex((c) => !c.frontMatter);
  return first === -1 ? 0 : first;
}

function readProgress(slug) {
  try {
    return JSON.parse(localStorage.getItem(progressKey(slug)) ?? 'null');
  } catch {
    return null; // private browsing, or storage disabled
  }
}

function writeProgress() {
  try {
    localStorage.setItem(
      progressKey(state.slug),
      JSON.stringify({ chapter: state.chapter, scroll: scrollY, at: Date.now() }),
    );
  } catch {
    // Losing the bookmark is not worth breaking the reader over.
  }
}

addEventListener('scroll', () => {
  if (!state) return;
  clearTimeout(state.scrollTimer);
  state.scrollTimer = setTimeout(writeProgress, 400);
}, { passive: true });

function onKey(event) {
  if (event.target.matches('input, select, textarea')) return;
  if (event.key === 'ArrowRight') go(state.chapter + 1);
  if (event.key === 'ArrowLeft') go(state.chapter - 1);
  if (event.key === ' ') {
    event.preventDefault(); // space scrolls by default, which fights playback
    state.player?.toggle();
  }
}
