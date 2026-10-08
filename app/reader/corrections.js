// Correcting chapter detection.
//
// Detection is a heuristic and is wrong on some books in ways only a reader
// can see: a newspaper headline quoted inside a story looks exactly like the
// story's title. This panel lists the chapters as detected, so a false one can
// be struck out, and switches the text into a marking mode where a missed
// heading can be pointed at.
//
// Corrections are made on the server, which rebuilds the book: they have to
// reach book.json, because the speech renderer reads that and not this page.

import { el } from '../core/dom.js';

const PATTERNS = {
  auto: 'Automatic',
  named: 'Named — CHAPTER I, LETTER 4',
  numeral: 'Numbered — I., 2.',
  caps: 'ALL-CAPITALS titles',
  none: 'No chapters',
};

const FOUND_BY = {
  named: 'named headings',
  numeral: 'numbered headings',
  caps: 'all-capitals titles',
};

const words = (chapter) =>
  chapter.blocks.reduce((n, b) => n + b.sentences.reduce((m, s) => m + s.text.split(/\s+/).length, 0), 0);

const formatWords = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k words` : `${n} words`);

/** Whether a book was built with the references corrections need. */
export const correctable = (book) => book.chapters.every((c) => 'firstBlock' in c);

export function correctionsPanel({ onCorrect, onGo, onMarking }) {
  const element = el('div', { className: 'panel corrections' });

  function render({ book, current, marking, busy, error }) {
    const corrections = book.corrections ?? null;
    const chapters = book.chapters.filter((c) => !c.frontMatter).length;

    const summary = book.detectedBy
      ? `${chapters} chapter${chapters === 1 ? '' : 's'}, found by ${FOUND_BY[book.detectedBy] ?? book.detectedBy}`
      : 'No chapter headings — the book reads as one continuous text';

    if (!correctable(book)) {
      element.replaceChildren(
        el('p', { className: 'corrections-summary', textContent: summary }),
        el('p', {
          className: 'note',
          textContent: 'This book was saved before chapters could be corrected. Rebuilding it from the '
            + 'original text adds what corrections need; nothing is downloaded again.',
        }),
        el('button', { textContent: busy ? 'Rebuilding…' : 'Rebuild', disabled: busy, onclick: () => onCorrect({ reset: true }) }),
        ...(error ? [el('p', { className: 'error', textContent: error })] : []),
      );
      return;
    }

    const pattern = el('select', {
      disabled: busy,
      onchange: (e) => onCorrect({ pattern: e.target.value }),
    });
    for (const [value, label] of Object.entries(PATTERNS)) {
      pattern.append(el('option', { value, textContent: label, selected: value === (corrections?.pattern ?? 'auto') }));
    }

    const list = el('ol', { className: 'chapter-list' }, book.chapters.map((chapter, i) => el('li', {
      className: i === current ? 'current' : '',
    }, [
      el('button', {
        className: 'chapter-link',
        textContent: chapter.title ?? `Chapter ${i + 1}`,
        title: chapter.title ?? '',
        onclick: () => onGo(i),
      }),
      ...(chapter.marked ? [el('span', { className: 'tag', textContent: 'marked' })] : []),
      el('span', { className: 'words', textContent: formatWords(words(chapter)) }),
      chapter.heading
        ? el('button', {
          className: 'unmark',
          textContent: 'Not a chapter',
          title: 'Fold this into the chapter before it',
          disabled: busy,
          onclick: () => onCorrect({ ref: chapter.heading, startsChapter: false }),
        })
        : el('span', { className: 'unmark' }),
    ])));

    // Struck-out headings are no longer in the list above, so this is the only
    // way back to one.
    const removed = (corrections?.remove ?? []).map((ref) => el('li', {}, [
      el('span', { textContent: `“${ref.text}” is not a chapter` }),
      el('button', {
        textContent: 'Undo',
        disabled: busy,
        onclick: () => onCorrect({ ref, startsChapter: true }),
      }),
    ]));

    // A correction can outlive the line it named, if a better pipeline cleans
    // that line differently. Say so rather than pretend it still applies.
    const lost = (corrections?.unresolved ?? []).length;

    element.replaceChildren(
      el('p', { className: 'corrections-summary', textContent: summary }),
      el('label', { className: 'control' }, [el('span', { className: 'control-label', textContent: 'Detect by' }), pattern]),
      list,
      ...(removed.length ? [el('ul', { className: 'corrections-list' }, removed)] : []),
      ...(lost ? [el('p', { className: 'error', textContent: `${lost} correction${lost === 1 ? '' : 's'} no longer match any line in the text.` })] : []),
      el('div', { className: 'corrections-actions' }, [
        el('button', {
          className: marking ? 'active' : '',
          textContent: marking ? 'Done marking' : 'Mark missed chapters',
          title: 'Tap a line in the text to make it the start of a chapter',
          onclick: () => onMarking(!marking),
        }),
        ...(corrections ? [el('button', { textContent: 'Reset to automatic', disabled: busy, onclick: () => onCorrect({ reset: true }) })] : []),
      ]),
      el('p', {
        className: 'note',
        textContent: busy
          ? 'Rebuilding…'
          : 'A correction renumbers every chapter after it, so audio rendered from those chapters will need rendering again.',
      }),
      ...(error ? [el('p', { className: 'error', textContent: error })] : []),
    );
  }

  return { element, render };
}
