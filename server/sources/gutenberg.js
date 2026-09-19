// Project Gutenberg.
//
// Searches a local mirror of the catalog when one has been built
// (`npm run index`), and falls back to the Gutendex API when it hasn't.
// Local search is instant and works offline; the API is a network round trip
// whose latency is erratic.
//
// Either way the text download has to happen server-side: gutenberg.org sends
// no CORS header on its text files, so a browser can never fetch them.

import { readFile } from 'node:fs/promises';

import { GUTENBERG_INDEX } from '../../scripts/build-index.js';

const API = 'https://gutendex.com';

export const id = 'gutenberg';
export const label = 'Project Gutenberg';

// ---------------------------------------------------------------- local index

let indexPromise = null;

function loadIndex() {
  indexPromise ??= readFile(GUTENBERG_INDEX, 'utf8')
    .then((raw) => {
      const data = JSON.parse(raw);
      return {
        builtAt: data.builtAt,
        catalogModified: data.catalogModified,
        withPopularity: data.withPopularity ?? 0,
        // Pre-lowercase the searchable text once, rather than on every query
        // across 78k rows.
        rows: data.books.map(([bookId, title, authors, language, subjects, shelves, downloads]) => ({
          bookId,
          title,
          authors,
          language,
          subjects,
          downloads: downloads ?? 0,
          haystack: `${title}\n${authors}\n${subjects}\n${shelves}`.toLowerCase(),
          titleLower: title.toLowerCase(),
          authorsLower: authors.toLowerCase(),
        })),
      };
    })
    .catch(() => null); // no index built yet
  return indexPromise;
}

/** Status for the UI: is this source answering locally, and how fresh is it? */
export async function status() {
  const index = await loadIndex();
  if (!index) {
    return { mode: 'remote', note: 'querying gutendex.com — run `npm run index` for instant local search' };
  }
  return {
    mode: 'local',
    books: index.rows.length,
    ranked: index.withPopularity,
    builtAt: index.builtAt,
    catalogModified: index.catalogModified,
  };
}

// Author names carry life dates in the catalog: `Shelley, Mary, 1797-1851`.
function splitAuthors(field) {
  if (!field) return [];
  return field
    .split(';')
    .map((a) => a.replace(/,\s*\d{3,4}\??\s*-\s*\d{0,4}\??\s*$/, '').trim())
    .filter(Boolean);
}

function fromIndex(row) {
  return {
    id: `gutenberg:${row.bookId}`,
    source: id,
    sourceId: String(row.bookId),
    title: row.title,
    authors: splitAuthors(row.authors),
    year: null,
    languages: row.language ? row.language.split(';').map((l) => l.trim()) : [],
    subjects: row.subjects ? row.subjects.split(';').map((s) => s.trim()).slice(0, 6) : [],
    cover: `https://www.gutenberg.org/cache/epub/${row.bookId}/pg${row.bookId}.cover.medium.jpg`,
    popularity: row.downloads,
    hasPlainText: true,
    sourceUrl: `https://www.gutenberg.org/ebooks/${row.bookId}`,
  };
}

function scoreRow(row, query, terms) {
  if (!row.haystack.includes(terms[0])) return 0; // cheap reject before real work

  let titleScore = 0;
  let otherScore = 0;

  if (row.titleLower === query) titleScore += 1000;
  else if (row.titleLower.startsWith(query)) titleScore += 300;
  else if (row.titleLower.includes(query)) titleScore += 200;

  for (const term of terms) {
    if (row.titleLower.includes(term)) titleScore += 60;
    else if (row.authorsLower.includes(term)) otherScore += 40;
    else if (row.haystack.includes(term)) otherScore += 8;
    else return 0; // every term must appear somewhere
  }

  // How much of the title the query actually accounts for.
  //
  // Without this, a long title that merely contains the query beats the work
  // itself: every result for "alice in wonderland" was a retelling or a
  // dramatization, because each contains that exact phrase while
  // `Alice's Adventures in Wonderland` does not. Only title matches are
  // scaled -- an author match shouldn't be punished for the title's length.
  const coverage = Math.min(1, query.length / Math.max(row.titleLower.length, 1));

  // Popularity separates a famous book from something whose title happens to
  // contain the query. Log-scaled, because counts span four orders of
  // magnitude.
  const popularity = Math.log10(1 + row.downloads) * 45;

  // Books outside the popularity crawl fall back to a weak prior: Gutenberg
  // numbers books in the order they were added, and the early numbers are
  // overwhelmingly the canon. Only ever a tiebreaker.
  const prior = row.downloads ? 0 : 30 / (1 + row.bookId / 2000);

  return titleScore * coverage + otherScore + popularity + prior;
}

async function searchIndex(query, limit) {
  const index = await loadIndex();
  if (!index) return null;

  const normalized = query.trim().toLowerCase();
  const terms = normalized.split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const hits = [];
  for (const row of index.rows) {
    const score = scoreRow(row, normalized, terms);
    if (score > 0) hits.push({ row, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map((h) => ({ ...fromIndex(h.row), relevance: h.score }));
}

// ------------------------------------------------------------------ remote API

function plainTextUrl(formats = {}) {
  const keys = Object.keys(formats).filter(
    (k) => k.startsWith('text/plain') && !formats[k].endsWith('.zip'),
  );
  const utf8 = keys.find((k) => k.includes('utf-8'));
  return formats[utf8 ?? keys[0]] ?? null;
}

function fromApi(raw) {
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

async function searchApi(query, limit, signal) {
  const res = await fetch(`${API}/books?search=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) throw new Error(`gutendex search failed: ${res.status}`);
  const data = await res.json();
  return (data.results ?? []).slice(0, limit).map(fromApi);
}

// ------------------------------------------------------------------- interface

export async function search(query, { limit = 20, signal } = {}) {
  return (await searchIndex(query, limit)) ?? searchApi(query, limit, signal);
}

export async function fetchText(sourceId, { signal } = {}) {
  // This path is predictable and redirects to whichever encoding exists, so
  // try it before spending a round trip on a catalog lookup.
  const direct = `https://www.gutenberg.org/ebooks/${encodeURIComponent(sourceId)}.txt.utf-8`;
  const res = await fetch(direct, { signal });
  if (res.ok) {
    const text = await res.text();
    return { text, textUrl: direct, book: { id: `gutenberg:${sourceId}`, source: id, sourceId } };
  }

  const metaRes = await fetch(`${API}/books/${encodeURIComponent(sourceId)}`, { signal });
  if (!metaRes.ok) throw new Error(`gutendex lookup failed: ${metaRes.status}`);
  const meta = await metaRes.json();

  const url = plainTextUrl(meta.formats);
  if (!url) throw new Error(`no plain text available for gutenberg:${sourceId}`);

  const textRes = await fetch(url, { signal });
  if (!textRes.ok) throw new Error(`gutenberg download failed: ${textRes.status}`);
  return { text: await textRes.text(), book: fromApi(meta), textUrl: url };
}
