// Playback, bound to the text.
//
// The audio was rendered offline one sentence at a time, and each clip was
// measured, so `sync.json` carries exact start and end times keyed by the
// same sentence ids the reader rendered as spans. Highlighting is therefore
// a lookup rather than an estimate -- no dependence on `onboundary` events,
// which are unreliable on iOS and absent for pre-rendered audio anyway.

import { el } from '../core/dom.js';

export function createPlayer({ slug, article, onStatus }) {
  const audio = new Audio();
  audio.preload = 'metadata';
  // Time-stretch rather than chipmunk the voice when playing faster.
  audio.preservesPitch = true;

  let renders = [];
  let render = null;
  let chapter = null;
  let timings = [];
  let highlighted = null;
  let follow = true; // keep the spoken sentence on screen

  async function load() {
    renders = await (await fetch(`/api/renders?book=${encodeURIComponent(slug)}`)).json();
    render = renders[0] ?? null;
    return render;
  }

  /** Bind the audio for one chapter, or report that it hasn't been rendered. */
  function setChapter(index) {
    stop();
    const rendered = render?.chapters.find((c) => c.index === index) ?? null;
    // Audio made from a chapter that has since changed would play, but every
    // timing in it would point at the wrong sentence.
    chapter = rendered?.stale ? null : rendered;
    timings = [];

    if (!chapter) {
      onStatus?.({ available: false, playing: false, stale: Boolean(rendered?.stale) });
      return false;
    }

    audio.src = `/books/${encodeURIComponent(slug)}/audio/${render.profile}/${chapter.file}`;
    fetchTimings(index);
    onStatus?.({ available: true, playing: false, duration: chapter.duration });
    return true;
  }

  async function fetchTimings(index) {
    const sync = await (await fetch(
      `/books/${encodeURIComponent(slug)}/audio/${render.profile}/sync.json`,
    )).json();
    timings = sync.chapters.find((c) => c.index === index)?.sentences ?? [];
  }

  // The highlight holds through the silence after a sentence until the next
  // one starts. Clearing during every gap would flicker at each full stop.
  function sentenceAt(time) {
    let lo = 0;
    let hi = timings.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timings[mid].start <= time) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  function highlight(id) {
    if (id === highlighted) return;
    article.querySelector('.sentence.speaking')?.classList.remove('speaking');
    highlighted = id;
    if (!id) return;

    const span = article.querySelector(`[data-sid="${CSS.escape(id)}"]`);
    if (!span) return;
    span.classList.add('speaking');

    if (!follow) return;
    const box = span.getBoundingClientRect();
    // Only scroll when the sentence has actually left the comfortable band,
    // so the page isn't nudged on every sentence.
    if (box.top < 90 || box.bottom > innerHeight - 90) {
      span.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  audio.addEventListener('timeupdate', () => {
    const index = sentenceAt(audio.currentTime);
    highlight(index >= 0 ? timings[index].id : null);
  });

  audio.addEventListener('play', () => onStatus?.({ available: true, playing: true }));
  audio.addEventListener('pause', () => onStatus?.({ available: true, playing: false }));
  audio.addEventListener('ended', () => {
    highlight(null);
    onStatus?.({ available: true, playing: false, ended: true });
  });

  function stop() {
    audio.pause();
    audio.removeAttribute('src');
    highlight(null);
  }

  function seekToSentence(id) {
    const found = timings.find((t) => t.id === id);
    if (!found) return false;
    audio.currentTime = found.start;
    highlight(id);
    return true;
  }

  function step(direction) {
    const index = sentenceAt(audio.currentTime);
    const next = Math.max(0, Math.min(index + direction, timings.length - 1));
    if (timings[next]) audio.currentTime = timings[next].start;
  }

  return {
    load,
    setChapter,
    seekToSentence,
    step,
    stop,
    get render() { return render; },
    get renders() { return renders; },
    get playing() { return !audio.paused; },
    get rate() { return audio.playbackRate; },
    set rate(value) { audio.playbackRate = value; },
    set follow(value) { follow = value; },
    toggle() {
      if (audio.paused) audio.play().catch(() => onStatus?.({ error: 'playback blocked' }));
      else audio.pause();
    },
    destroy() {
      stop();
      audio.src = '';
    },
  };
}

/** The transport controls. Returns the element plus the handles to update it. */
export function playerBar({ onToggle, onStep, onRate }) {
  const play = el('button', { className: 'play', textContent: '▶', title: 'Play (space)', onclick: onToggle });
  const status = el('span', { className: 'player-status' });

  const rate = el('select', {
    className: 'rate',
    title: 'Playback speed, on top of the speed baked in at render time',
    onchange: (e) => onRate(Number(e.target.value)),
  });
  for (const r of [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]) {
    rate.append(el('option', { value: String(r), textContent: `${r}×`, selected: r === 1 }));
  }

  const element = el('div', { className: 'player' }, [
    el('button', { className: 'step', textContent: '⟨', title: 'Previous sentence', onclick: () => onStep(-1) }),
    play,
    el('button', { className: 'step', textContent: '⟩', title: 'Next sentence', onclick: () => onStep(1) }),
    status,
    rate,
  ]);

  return {
    element,
    status,
    setPlaying(playing) {
      play.textContent = playing ? '❚❚' : '▶';
      play.title = playing ? 'Pause (space)' : 'Play (space)';
    },
    setEnabled(enabled) {
      for (const node of [play, rate, ...element.querySelectorAll('.step')]) node.disabled = !enabled;
    },
  };
}
