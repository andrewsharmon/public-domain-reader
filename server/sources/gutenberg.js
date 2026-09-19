// Project Gutenberg, via the Gutendex catalog API.
//
// Gutendex serves CORS `*` so the catalog could be queried straight from the
// browser, but gutenberg.org itself sends no CORS header on the text files --
// so the actual download has to happen here, server-side.

const API = 'https://gutendex.com';

export const id = 'gutenberg';
export const label = 'Project Gutenberg';

// Gutendex reports several plain-text flavors and the key carries the charset,
// e.g. `text/plain; charset=utf-8`. Prefer utf-8, take any plain text
// otherwise, and never take the `.zip` variants.
function plainTextUrl(formats = {}) {
  const keys = Object.keys(formats).filter(
    (k) => k.startsWith('text/plain') && !formats[k].endsWith('.zip'),
  );
  const utf8 = keys.find((k) => k.includes('utf-8'));
  return formats[utf8 ?? keys[0]] ?? null;
}

function toBook(raw) {
  return {
    id: `gutenberg:${raw.id}`,
    source: id,
    sourceId: String(raw.id),
    title: raw.title,
    authors: (raw.authors ?? []).map((a) => a.name),
    year: (raw.authors ?? [])[0]?.death_year ?? null,
    languages: raw.languages ?? [],
    subjects: (raw.subjects ?? []).slice(0, 6),
    cover: raw.formats?.['image/jpeg'] ?? null,
    popularity: raw.download_count ?? 0,
    hasPlainText: Boolean(plainTextUrl(raw.formats)),
    sourceUrl: `https://www.gutenberg.org/ebooks/${raw.id}`,
  };
}

export async function search(query, { limit = 20, signal } = {}) {
  const url = `${API}/books?search=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`gutendex search failed: ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).slice(0, limit).map(toBook);
}

export async function fetchText(sourceId, { signal } = {}) {
  const metaRes = await fetch(`${API}/books/${encodeURIComponent(sourceId)}`, { signal });
  if (!metaRes.ok) throw new Error(`gutendex lookup failed: ${metaRes.status}`);
  const meta = await metaRes.json();

  const url = plainTextUrl(meta.formats);
  if (!url) throw new Error(`no plain text available for gutenberg:${sourceId}`);

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`gutenberg download failed: ${res.status}`);
  return { text: await res.text(), book: toBook(meta), textUrl: url };
}
