// The reader.
//
// Renders one chapter at a time. Moby-Dick is 9,000 sentences across 132
// chapters, and putting all of it in the DOM makes scrolling stutter on a
// phone for no benefit -- nobody reads two chapters at once.
//
// Every sentence is rendered as its own span carrying the id the pipeline
// assigned it, which is what the player highlights against and what a tap
// seeks to.

import { el } from '../core/dom.js';
import { MAX_HEADING_CHARS } from '../core/pipeline/chapters.js';
import { loadSettings, saveSettings, applySettings, settingsPanel } from './settings.js';
import { createPlayer, playerBar } from './player.js';
import { correctionsPanel } from './corrections.js';

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

  state = { slug, book, settings, chapter: restoreChapter(slug, book), marking: false, busy: false, error: null };

  const article = el('article', { className: 'prose' });
  const title = el('span', { className: 'chapter-title' });

  const picker = el('select', {
    className: 'chapters',
    title: 'Chapters',
    onchange: (e) => go(Number(e.target.value)),
  });
  fillPicker(picker, book);

  const panel = settingsPanel(state.settings, (next) => {
    state.settings = next;
    applySettings(next);
    saveSettings(next);
  });

  const corrections = correctionsPanel({
    onCorrect: correct,
    onGo: (i) => go(i),
    onMarking: (on) => {
      // Marking happens in the text, which the panel would be covering.
      corrections.element.classList.remove('open');
      setMarking(on);
    },
  });

  // One panel at a time: both sit in the same place under the bar.
  const toggle = (open) => {
    for (const p of [panel, corrections.element]) p.classList.toggle('open', p === open && !p.classList.contains('open'));
    if (corrections.element.classList.contains('open')) renderCorrections();
  };

  const bar = el('div', { className: 'bar' }, [
    el('a', { className: 'icon', href: '#/library', textContent: '‹ Library', title: 'Back to library' }),
    title,
    el('div', { className: 'bar-actions' }, [
      picker,
      el('button', {
        className: 'icon',
        textContent: '§',
        title: 'Chapters — correct how this book was divided',
        onclick: () => toggle(corrections.element),
      }),
      el('button', {
        className: 'icon',
        textContent: 'Aa',
        title: 'Reading settings',
        onclick: () => toggle(panel),
      }),
    ]),
  ]);

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
  // While marking chapters, a tap picks a line instead.
  article.addEventListener('click', (event) => {
    if (state.marking) return offerMark(event.target.closest?.('[data-block]'));
    const span = event.target.closest?.('.sentence');
    if (span) state.player.seekToSentence(span.dataset.sid);
  });

  root.append(bar, panel, corrections.element, transport.element, article, nav);
  state.el = { article, title, nav, picker, transport, corrections };

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
    transport.status.textContent = status.stale
      ? 'this chapter changed after it was rendered — render it again'
      : state?.player?.render
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

function go(index, { restoreScroll = false, keepScroll = false } = {}) {
  const { book, el: nodes } = state;
  const clamped = Math.max(0, Math.min(index, book.chapters.length - 1));
  state.chapter = clamped;

  const chapter = book.chapters[clamped];
  nodes.title.textContent = chapter.title ?? book.title ?? '';

  // A run of separator rows is one scene break, so only the first is drawn.
  // Filtered after numbering, because marking a line names it by its index.
  const blocks = chapter.blocks
    .map((block, b) => renderBlock(block, b))
    .filter((_, i) => chapter.blocks[i].type !== 'break' || chapter.blocks[i - 1]?.type !== 'break');

  const heading = chapter.title ? el('h1', { textContent: chapter.title }) : null;
  if (heading && state.marking && chapter.heading) {
    heading.append(markButton('Not a chapter', 'Fold this into the chapter before it', () =>
      correct({ ref: chapter.heading, startsChapter: false }, { anchor: chapter.firstBlock - 1 })));
  }

  const hint = state.marking
    ? [el('p', { className: 'marking-hint' }, [
      el('span', { textContent: 'Tap the line that should start a chapter.' }),
      el('button', { type: 'button', textContent: 'Done', onclick: () => setMarking(false) }),
    ])]
    : [];

  nodes.article.classList.toggle('marking', state.marking);
  nodes.article.replaceChildren(...hint, ...(heading ? [heading] : []), ...blocks);

  // Keep the picker in step when navigation came from the arrows or keyboard.
  nodes.picker.value = String(clamped);

  const [prev, next] = nodes.nav.children;
  prev.disabled = clamped === 0;
  next.disabled = clamped === book.chapters.length - 1;

  if (!keepScroll) {
    const saved = restoreScroll ? readProgress(state.slug)?.scroll ?? 0 : 0;
    scrollTo({ top: saved, behavior: 'instant' });
  }
  writeProgress();
  renderCorrections();

  if (state.player?.render) bindAudio();
}

function renderBlock(block, b) {
  // A scene break is drawn, not typeset.
  if (block.type === 'break') return el('hr', { className: 'scene-break', dataset: { block: String(b) } });

  const node = el('p', { className: block.type === 'verse' ? 'verse' : 'para', dataset: { block: String(b) } });

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

function setMarking(on) {
  state.marking = on;
  go(state.chapter, { keepScroll: true });
}

// A tapped line gets one button, rather than every candidate getting its own:
// in dialogue-heavy prose nearly every line is short enough to be a title.
function offerMark(node) {
  state.el.article.querySelector('.mark.offer')?.remove();
  const b = Number(node?.dataset.block);
  const chapter = state.book.chapters[state.chapter];
  const block = chapter.blocks[b];
  if (!block?.sentences.length) return;

  // Only a short line can be marked, because it becomes the chapter's title
  // and leaves the text.
  const short = block.sentences.map((s) => s.text).join(' ').length <= MAX_HEADING_CHARS;
  const button = short
    ? markButton('Start a chapter here', 'Make this line the title of a new chapter', () => correct(
      { chapter: state.chapter, block: b, text: block.sentences[0].text, startsChapter: true },
      { anchor: chapter.firstBlock + b },
    ))
    : el('span', { className: 'mark', textContent: 'Too long to be a title' });
  button.classList.add('offer');
  node.append(button);
}

function markButton(label, title, onclick) {
  return el('button', {
    type: 'button',
    className: 'mark',
    textContent: label,
    title,
    disabled: state.busy,
    onclick: (event) => {
      event.stopPropagation(); // not a tap on the text, which would seek the audio
      onclick();
    },
  });
}

function fillPicker(select, book) {
  select.replaceChildren(...book.chapters.map((c, i) =>
    el('option', { value: String(i), textContent: c.title ?? `Chapter ${i + 1}` })));
}

// ---------------------------------------------------------------- corrections

function renderCorrections() {
  const panel = state?.el?.corrections;
  if (!panel?.element.classList.contains('open')) return;
  panel.render({
    book: state.book,
    current: state.chapter,
    marking: state.marking,
    busy: state.busy,
    error: state.error,
  });
}

/**
 * Send one correction, then reload the rebuilt book.
 *
 * Chapter numbers shift under a correction, so where to land afterwards is
 * named by `anchor`: a block's index in the whole book, which does not move.
 * By default that is the start of the chapter being read, so striking out a
 * chapter elsewhere leaves you on the same text.
 */
async function correct(edit, { anchor } = {}) {
  const mine = state;
  const current = state.book.chapters[state.chapter];
  // A book saved before corrections existed has no block positions to aim
  // at; rebuilding it changes nothing, so it stays on the same chapter.
  const target = anchor ?? ('firstBlock' in current
    ? (current.heading ? current.firstBlock - 1 : current.firstBlock)
    : null);

  state.busy = true;
  state.error = null;
  renderCorrections();

  let rebuilt = false;
  try {
    const res = await fetch(`/api/chapters?book=${encodeURIComponent(state.slug)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edit),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `the correction failed (${res.status})`);

    const reloaded = await fetch(`/books/${encodeURIComponent(state.slug)}/book.json`);
    if (!reloaded.ok) throw new Error(`could not reload the book (${reloaded.status})`);
    const book = await reloaded.json();
    if (state !== mine) return; // the reader was closed meanwhile
    state.book = book;
    fillPicker(state.el.picker, state.book);
    rebuilt = true;
  } catch (err) {
    if (state !== mine) return;
    state.error = err.message;
  }
  state.busy = false;

  if (rebuilt && target !== null) land(target);
  else go(state.chapter, { keepScroll: true });
  // Renders are checked against the rebuilt chapters, so ask again which
  // still fit.
  state.player?.load().then(() => bindAudio());
}

// Open the chapter that now holds a block, and bring that block into view.
function land(block) {
  const chapters = state.book.chapters;
  const start = (c) => (c.heading ? c.firstBlock - 1 : c.firstBlock ?? 0);
  let index = 0;
  chapters.forEach((c, i) => {
    if (start(c) <= block) index = i;
  });

  go(index);
  const local = block - (chapters[index].firstBlock ?? 0);
  if (local > 0) {
    state.el.article.querySelector(`[data-block="${local}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
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
