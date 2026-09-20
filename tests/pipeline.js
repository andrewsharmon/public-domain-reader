// Runs the text pipeline over a deliberately awkward set of books.
//
// The pipeline is all heuristics -- there is no markup in a plain text book to
// rely on -- so the only honest way to check it is against real files with
// genuinely different shapes: numbered chapters, named chapters, epistolary
// letters, story collections, poetry, and works with no divisions at all.
//
//   node tests/pipeline.js        (needs `npm start` running)

import { buildBook } from '../app/core/pipeline/index.js';

const BASE = process.env.BASE ?? 'http://localhost:8080';

export const CORPUS = [
  { id: '84', source: 'gutenberg', title: 'Frankenstein', expect: { chapters: 28 }, note: 'Letters + Chapters, has a TOC' },
  { id: '1342', source: 'gutenberg', title: 'Pride and Prejudice', expect: { chapters: 61 }, note: 'plain numbered chapters' },
  { id: '11', source: 'gutenberg', title: "Alice in Wonderland", expect: { chapters: 12 }, note: 'numbered + named chapters' },
  { id: '2701', source: 'gutenberg', title: 'Moby Dick', expect: { chapters: 136 }, note: 'many chapters, long front matter' },
  { id: '1661', source: 'gutenberg', title: 'Sherlock Holmes', expect: { chapters: 12 }, note: 'ADVENTURE I. style headings' },
  { id: '2814', source: 'gutenberg', title: 'Dubliners', expect: { chapters: 15 }, note: 'story collection, ALL CAPS titles' },
  { id: '1952', source: 'gutenberg', title: 'The Yellow Wallpaper', expect: { chapters: 1 }, note: 'short story, no divisions, one implicit chapter' },
  { id: '1322', source: 'gutenberg', title: 'Leaves of Grass', expect: {}, note: 'poetry, verse throughout' },
  // Exposed two real bugs: `BOOK I` sits directly above `PERSONS OF THE
  // DIALOGUE.` with nothing between, and the index leaves fragments like `_]`
  // that have no phonemes and killed a multi-hour render.
  { id: '55201', source: 'gutenberg', title: 'The Republic', expect: { chapters: 14 }, note: 'heading above subheading, index debris' },
];

async function load(entry) {
  const res = await fetch(`${BASE}/api/text?source=${entry.source}&id=${entry.id}`);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return (await res.json()).text;
}

export async function run() {
  const rows = [];
  for (const entry of CORPUS) {
    try {
      const book = buildBook(await load(entry), { source: entry.source, sourceId: entry.id });
      rows.push({ entry, stats: book.stats, book });
    } catch (err) {
      rows.push({ entry, error: err.message });
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await run();
  console.log(
    `${'book'.padEnd(22)}${'chapters'.padStart(9)}${'expected'.padStart(9)}` +
    `${'sentences'.padStart(10)}${'words'.padStart(8)}${'verse%'.padStart(8)}  note`,
  );
  for (const { entry, stats, book, error } of rows) {
    if (error) {
      console.log(`${entry.title.padEnd(22)}  ERROR ${error}`);
      continue;
    }
    const blocks = book.chapters.flatMap((c) => c.blocks);
    const verse = Math.round((blocks.filter((b) => b.type === 'verse').length / blocks.length) * 100);
    const want = entry.expect.chapters;
    const flag = want === undefined ? ' ' : stats.chapters === want ? '✓' : '✗';
    console.log(
      `${entry.title.padEnd(22)}${String(stats.chapters).padStart(9)}${String(want ?? '—').padStart(8)}${flag}` +
      `${String(stats.sentences).padStart(10)}${String(stats.words).padStart(8)}${String(verse).padStart(7)}%  ${entry.note}`,
    );
  }
}
