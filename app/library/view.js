// The library: everything saved to disk, and the way into a book.

import { el, formatDuration } from '../core/dom.js';

export async function mount(root) {
  const books = await (await fetch('/api/library')).json();

  if (!books.length) {
    root.append(
      el('div', { className: 'empty' }, [
        el('h1', { textContent: 'Your library is empty' }),
        el('p', {
          className: 'status',
          textContent: 'Find a book and press Save, and it will be downloaded and kept here.',
        }),
        el('a', { className: 'button', href: '#/discover', textContent: 'Find books' }),
      ]),
    );
    return;
  }

  root.append(
    el('div', { className: 'page' }, [
      el('h1', { textContent: 'Library' }),
      el('p', {
        className: 'status',
        textContent: `${books.length} book${books.length === 1 ? '' : 's'} saved to disk.`,
      }),
      el('div', { className: 'shelf' }, books.map(card)),
    ]),
  );
}

function card(book) {
  const authors = book.authors?.join(', ') || 'Unknown author';
  const { chapters, words, minutesAt160wpm } = book.stats ?? {};

  return el('a', { className: 'card', href: `#/read/${encodeURIComponent(book.slug)}` }, [
    el('h2', { textContent: book.title ?? book.slug }),
    el('p', { className: 'byline', textContent: authors }),
    el('p', { className: 'stats' }, [
      el('span', { className: 'tag', textContent: book.source ?? '' }),
      el('span', {
        textContent: [
          chapters ? `${chapters} chapters` : null,
          words ? `${words.toLocaleString()} words` : null,
          minutesAt160wpm ? `${formatDuration(minutesAt160wpm)} listening` : null,
        ].filter(Boolean).join(' · '),
      }),
    ]),
  ]);
}
