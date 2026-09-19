// Finding books across the archives, and saving them to the library.
//
// Saving happens on the server because the server is the Mac: the point is
// real files on disk that an offline render can read, not a copy trapped in
// browser storage.

import { el, formatDuration } from '../core/dom.js';

let sourceInfo = [];

export async function mount(root) {
  const input = el('input', {
    type: 'search',
    name: 'q',
    placeholder: 'Search for a book or author…',
    autocomplete: 'off',
    required: true,
  });

  const status = el('p', { className: 'status', textContent: 'Loading sources…' });
  const sources = el('div', { className: 'sources' });
  const results = el('div', { className: 'results' });

  const form = el('form', {
    onsubmit: (e) => {
      e.preventDefault();
      runSearch(input.value.trim(), { status, sources, results });
    },
  }, [input, el('button', { type: 'submit', textContent: 'Search' })]);

  root.append(el('div', { className: 'page' }, [
    el('h1', { textContent: 'Find books' }),
    form,
    status,
    sources,
    results,
  ]));

  await loadSources(sources, status);
  input.focus();
}

// Each archive answers either from the local mirror or over the network, and
// the network ones are volunteer-run and erratic. Showing which is which --
// and how each just fared -- makes a slow search legible instead of a spinner
// that might never end.
function renderSources(container, list) {
  container.replaceChildren(...list.map((s) =>
    el('span', {
      className: `source ${s.state ?? s.mode}`,
      title: s.note ?? '',
      textContent: `${s.label ?? s.source} · ${s.detail}`,
    }),
  ));
}

async function loadSources(container, status) {
  try {
    sourceInfo = await (await fetch('/api/sources')).json();
    renderSources(container, sourceInfo.map((s) => ({
      ...s,
      detail: s.mode === 'local' ? `local · ${s.books.toLocaleString()} books` : 'live query',
    })));
    status.textContent = 'Search Project Gutenberg, Internet Archive and Wikisource.';
  } catch {
    status.textContent = 'Search the archives.';
  }
}

function showSearchStatus(container, statuses) {
  const byId = Object.fromEntries(sourceInfo.map((s) => [s.id, s]));
  renderSources(container, statuses.map((s) => {
    const info = byId[s.source] ?? {};
    if (!s.ok) {
      return { ...info, state: 'failed', detail: s.timedOut ? 'timed out' : 'failed', note: s.message };
    }
    return {
      ...info,
      state: info.mode === 'local' ? 'local' : 'remote',
      detail: `${s.count} · ${s.ms < 1000 ? `${s.ms}ms` : `${(s.ms / 1000).toFixed(1)}s`}`,
    };
  }));
}

async function runSearch(query, ui) {
  if (!query) return;
  ui.status.textContent = `Searching for “${query}”…`;
  ui.results.replaceChildren();

  try {
    const data = await (await fetch(`/api/search?q=${encodeURIComponent(query)}`)).json();
    showSearchStatus(ui.sources, data.sources);
    ui.status.textContent = `${data.count} results`;
    ui.results.append(...data.results.map(resultCard));
  } catch (err) {
    ui.status.textContent = `Search failed: ${err.message}`;
  }
}

function resultCard(book) {
  const note = el('p', { className: 'note' });
  const button = el('button', {
    type: 'button',
    textContent: 'Save',
    onclick: () => save(book, button, note),
  });

  return el('article', { className: 'book' }, [
    el('div', { className: 'row' }, [
      el('div', {}, [
        el('h2', { textContent: book.title }),
        el('p', { className: 'meta' }, [
          el('span', { className: 'tag', textContent: book.source }),
          el('span', {
            textContent: ` ${book.authors.join(', ') || 'Unknown author'}` +
              (book.year ? ` · ${book.year}` : ''),
          }),
        ]),
      ]),
      button,
    ]),
    note,
  ]);
}

async function save(book, button, note) {
  button.disabled = true;
  button.textContent = 'Saving…';
  note.textContent = 'Downloading and parsing…';

  try {
    const res = await fetch('/api/library', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: book.source, id: book.sourceId, meta: book }),
    });
    const data = await res.json();

    if (!res.ok) {
      // Wikisource answers an ambiguous title with the editions it could mean.
      note.textContent = data.code === 'AMBIGUOUS'
        ? `That title is a navigation page. Did you mean: ${data.choices.slice(0, 5).join(', ')}`
        : data.error ?? 'Save failed.';
      button.disabled = false;
      button.textContent = 'Save';
      return;
    }

    button.textContent = 'Saved';
    const { chapters, words, minutesAt160wpm } = data.stats;
    note.replaceChildren(
      el('span', {
        textContent: `${chapters} chapters, ${words.toLocaleString()} words, ` +
          `about ${formatDuration(minutesAt160wpm)} of listening — `,
      }),
      el('a', { href: `#/read/${encodeURIComponent(data.slug)}`, textContent: 'Read it now' }),
    );
  } catch (err) {
    note.textContent = `Save failed: ${err.message}`;
    button.disabled = false;
    button.textContent = 'Save';
  }
}
