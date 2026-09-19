// Prong 1 scaffold: proves the search fan-out end to end. The real discovery
// UI (facets, source filters, preview, save-to-library) lands in phase 1.

const form = document.querySelector('#search');
const status = document.querySelector('#status');
const results = document.querySelector('#results');

const escape = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render(book) {
  const el = document.createElement('article');
  el.className = 'book';
  el.innerHTML = `
    <h2>${escape(book.title)}</h2>
    <p class="meta">
      <span class="tag">${escape(book.source)}</span>
      ${escape(book.authors.join(', ') || 'Unknown author')}
      ${book.year ? ` &middot; ${escape(book.year)}` : ''}
    </p>`;
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

    status.textContent = `${data.count} results` +
      (data.errors.length ? ` — ${data.errors.map((e) => `${e.source} failed`).join(', ')}` : '');
    results.append(...data.results.map(render));
  } catch (err) {
    status.textContent = `Search failed: ${err.message}`;
  }
});
