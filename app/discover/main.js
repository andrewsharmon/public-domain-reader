// Prong 1: search the archives, save what you want to the library.
//
// Saving happens on the server because the server is the Mac -- the point is
// real files on disk that an offline TTS render and any other tool can read,
// not a copy trapped in browser storage.

const form = document.querySelector('#search');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const sourcesEl = document.querySelector('#sources');

// Slugs already on disk, so results can show what you have.
const saved = new Set();

const escape = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Each archive answers either from the local mirror or over the network, and
// the network ones are volunteer-run and erratic. Showing which is which --
// and how each one just fared -- makes a slow search legible instead of a
// spinner that might never end.
function renderSources(list) {
  sourcesEl.replaceChildren(
    ...list.map((s) => {
      const el = document.createElement('span');
      el.className = `source ${s.state ?? s.mode}`;
      el.title = s.note ?? '';
      el.textContent = `${s.label ?? s.source} · ${s.detail}`;
      return el;
    }),
  );
}

let sourceInfo = [];

async function loadSources() {
  try {
    sourceInfo = await (await fetch('/api/sources')).json();
    renderSources(
      sourceInfo.map((s) => ({
        ...s,
        detail:
          s.mode === 'local'
            ? `local · ${s.books.toLocaleString()} books`
            : 'live query',
      })),
    );
  } catch {
    sourcesEl.replaceChildren();
  }
}

// Fold the per-search outcome back into the same chips.
function showSearchStatus(statuses) {
  const byId = Object.fromEntries(sourceInfo.map((s) => [s.id, s]));
  renderSources(
    statuses.map((s) => {
      const info = byId[s.source] ?? {};
      if (!s.ok) {
        return { ...info, state: 'failed', detail: s.timedOut ? 'timed out' : 'failed', note: s.message };
      }
      return {
        ...info,
        state: info.mode === 'local' ? 'local' : 'remote',
        detail: `${s.count} · ${s.ms < 1000 ? `${s.ms}ms` : `${(s.ms / 1000).toFixed(1)}s`}`,
        note: info.note,
      };
    }),
  );
}

async function loadLibrary() {
  try {
    const books = await (await fetch('/api/library')).json();
    for (const b of books) saved.add(b.slug);
    status.textContent = books.length
      ? `${books.length} book${books.length === 1 ? '' : 's'} in your library. Search to add more.`
      : 'Search Project Gutenberg, Internet Archive and Wikisource.';
  } catch {
    status.textContent = 'Search Project Gutenberg, Internet Archive and Wikisource.';
  }
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
      if (data.code === 'AMBIGUOUS') {
        note.innerHTML =
          `That title is a navigation page. Did you mean: ` +
          data.choices.slice(0, 5).map((c) => `<em>${escape(c)}</em>`).join(', ');
      } else {
        note.textContent = data.error ?? 'Save failed.';
      }
      button.disabled = false;
      button.textContent = 'Save';
      return;
    }

    saved.add(data.slug);
    button.textContent = 'Saved';
    const { chapters, words, minutesAt160wpm } = data.stats;
    const hours = Math.floor(minutesAt160wpm / 60);
    const listening = hours ? `${hours}h ${minutesAt160wpm % 60}m` : `${minutesAt160wpm}m`;
    note.innerHTML =
      `<code>library/${escape(data.slug)}/</code> — ${chapters} chapters, ` +
      `${words.toLocaleString()} words, about ${listening} of listening`;
  } catch (err) {
    note.textContent = `Save failed: ${err.message}`;
    button.disabled = false;
    button.textContent = 'Save';
  }
}

function render(book) {
  const el = document.createElement('article');
  el.className = 'book';
  el.innerHTML = `
    <div class="row">
      <div>
        <h2>${escape(book.title)}</h2>
        <p class="meta">
          <span class="tag">${escape(book.source)}</span>
          ${escape(book.authors.join(', ') || 'Unknown author')}
          ${book.year ? ` &middot; ${escape(book.year)}` : ''}
        </p>
      </div>
      <button type="button">Save</button>
    </div>
    <p class="note"></p>`;

  const button = el.querySelector('button');
  const note = el.querySelector('.note');
  button.addEventListener('click', () => save(book, button, note));
  return el;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const q = new FormData(form).get('q');

  status.textContent = `Searching for “${q}”…`;
  results.replaceChildren();

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();

    showSearchStatus(data.sources);
    status.textContent = `${data.count} results`;
    results.append(...data.results.map(render));
  } catch (err) {
    status.textContent = `Search failed: ${err.message}`;
  }
});

loadSources();
loadLibrary();
