// Rebuild every saved book from its original text.
//
//   npm run reparse
//
// The pipeline is all heuristics and will keep improving, but a saved book
// holds whatever the pipeline produced on the day it was saved. This re-runs
// the current pipeline over the text already on disk, so a fix reaches books
// you saved months ago without downloading anything again.

import { list, save } from '../server/library.js';
import * as cache from '../server/cache.js';
import * as gutenberg from '../server/sources/gutenberg.js';
import * as archive from '../server/sources/archive.js';
import * as wikisource from '../server/sources/wikisource.js';

const SOURCES = { gutenberg, archive, wikisource };

const books = await list();
if (!books.length) {
  console.log('Nothing saved yet.');
  process.exit(0);
}

for (const book of books) {
  const { source, sourceId, title, slug } = book;
  process.stdout.write(`${(title ?? slug).slice(0, 46).padEnd(48)}`);

  try {
    // Prefer the cached original; fall back to re-fetching if it was cleared.
    let hit = await cache.read(source, sourceId);
    if (!hit) {
      hit = await SOURCES[source].fetchText(sourceId, { signal: AbortSignal.timeout(120_000) });
      await cache.write(source, sourceId, hit);
    }

    const before = book.stats?.chapters ?? 0;
    const { stats } = await save(hit.text, book);
    const delta = stats.chapters - before;
    console.log(`${String(stats.chapters).padStart(4)} chapters${delta ? `  (${delta > 0 ? '+' : ''}${delta})` : ''}`);
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  }
}
