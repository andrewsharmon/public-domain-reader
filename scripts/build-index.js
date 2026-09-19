// Build a local copy of the Project Gutenberg catalog.
//
//   npm run index
//
// Gutenberg publishes its whole catalog as a CSV, refreshed daily. Mirroring
// it turns search from a network round trip into a memory scan, which matters
// for two reasons: these archives are volunteer-run and their latency is
// erratic (Gutendex has answered the same query in 0.2s and in 26s), and the
// CSV carries Subjects and Bookshelves that the per-query API never returns.
//
// Only Gutenberg is mirrored. Wikisource publishes titles but no author
// metadata, and the Internet Archive has tens of millions of items and no
// dump to mirror -- both stay live queries.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CATALOG_URL = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv';
const GUTENDEX = 'https://gutendex.com/books';

// The catalog CSV has no download counts, and without them search cannot tell
// `Alice's Adventures in Wonderland` from `Alice in Wonderland, Retold in
// Words of One Syllable` -- the retelling actually contains the query as a
// literal substring, so it wins on text alone. Gutendex will hand back books
// ordered by popularity, 32 per page, so a bounded crawl of the head of that
// list restores the one signal that matters for ranking the canon.
const POPULAR_BOOKS = 3200;
const PAGE_SIZE = 32;
// Gutendex is volunteer-run and rate-limits: six concurrent requests lost 58
// of 100 pages. Two, with backoff, is both politer and far more complete.
const CONCURRENCY = 2;
const RETRIES = 3;
export const INDEX_DIR = path.join(process.cwd(), 'index');
export const GUTENBERG_INDEX = path.join(INDEX_DIR, 'gutenberg.json');

// A CSV parser rather than a split on commas: titles and subject lists are
// full of quoted commas and embedded newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPopularity({ log }) {
  const pages = Math.ceil(POPULAR_BOOKS / PAGE_SIZE);
  const counts = new Map();
  let failed = 0;

  log(`Fetching download counts for the ${POPULAR_BOOKS.toLocaleString()} most popular …`);

  const queue = Array.from({ length: pages }, (_, i) => i + 1);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const page = queue.shift();
        let ok = false;

        for (let attempt = 0; attempt < RETRIES && !ok; attempt += 1) {
          if (attempt) await sleep(500 * 2 ** attempt); // back off before retrying
          try {
            const res = await fetch(`${GUTENDEX}?sort=popular&page=${page}`, {
              signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) throw new Error(String(res.status));
            for (const b of (await res.json()).results ?? []) {
              counts.set(b.id, b.download_count ?? 0);
            }
            ok = true;
          } catch {
            // Retry; popularity is an enhancement, not a requirement.
          }
        }

        // A missing page costs ranking quality for a few books, not the index.
        if (!ok) failed += 1;
        else await sleep(120); // stay under the rate limit
      }
    }),
  );

  log(`  ${counts.size.toLocaleString()} counts${failed ? ` (${failed} pages failed)` : ''}`);
  return counts;
}

export async function build({ log = console.log, popularity = true } = {}) {
  log(`Downloading ${CATALOG_URL} …`);
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`catalog download failed: ${res.status}`);
  const csv = await res.text();
  log(`  ${(csv.length / 1e6).toFixed(1)} MB`);

  const [header, ...rows] = parseCsv(csv);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  // Stored as arrays rather than objects: at ~78k entries the repeated keys
  // would roughly double the file for no benefit.
  const counts = popularity ? await fetchPopularity({ log }) : new Map();

  const books = rows
    .filter((r) => r[col.Type] === 'Text' && r[col['Text#']])
    .map((r) => {
      const bookId = Number(r[col['Text#']]);
      return [
        bookId,
        r[col.Title].replace(/\s+/g, ' ').trim(),
        r[col.Authors].trim(),
        r[col.Language].trim(),
        r[col.Subjects].trim(),
        r[col.Bookshelves].trim(),
        counts.get(bookId) ?? 0,
      ];
    });

  await mkdir(INDEX_DIR, { recursive: true });
  await writeFile(
    GUTENBERG_INDEX,
    JSON.stringify({
      source: 'gutenberg',
      builtAt: new Date().toISOString(),
      catalogModified: res.headers.get('last-modified'),
      fields: ['id', 'title', 'authors', 'language', 'subjects', 'bookshelves', 'downloads'],
      withPopularity: counts.size,
      books,
    }),
    'utf8',
  );

  log(`Indexed ${books.length.toLocaleString()} books → ${GUTENBERG_INDEX}`);
  return books.length;
}

if (import.meta.url === `file://${process.argv[1]}`) await build();
