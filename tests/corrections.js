// Chapter corrections, against the books detection is known to get wrong.
//
// Detection cannot be right on every book, so these pin the other half of the
// contract: that a reader's correction lands on the line it named, survives a
// rebuild, and leaves the sentence ids of every chapter before it alone --
// those ids are what rendered audio is keyed by.
//
//   node tests/corrections.js        (needs `npm start` running)

import { buildBook } from '../app/core/pipeline/index.js';

const BASE = process.env.BASE ?? 'http://localhost:8080';

async function load(id) {
  const res = await fetch(`${BASE}/api/text?source=gutenberg&id=${id}`);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return (await res.json()).text;
}

// Written as corrections.json would hold them. `nth` counts earlier lines with
// the same text, which is why Moby-Dick's are 1: the contents list comes first.
const CASES = [
  {
    id: '1661',
    title: 'Sherlock Holmes',
    want: 12,
    why: 'numbered sections inside A Scandal in Bohemia are not stories',
    chapters: { remove: [{ text: 'II.', nth: 0 }, { text: 'III.', nth: 0 }] },
  },
  {
    id: '2814',
    title: 'Dubliners',
    want: 15,
    why: 'the book title and two quoted newspaper headlines',
    chapters: {
      remove: [
        { text: 'DUBLINERS', nth: 0 },
        { text: 'DEATH OF A LADY AT SYDNEY PARADE', nth: 0 },
        { text: 'MUNICIPAL ELECTIONS', nth: 0 },
      ],
    },
  },
  {
    id: '2701',
    title: 'Moby-Dick',
    want: 136,
    why: 'headings too long to detect, and the Epilogue',
    chapters: {
      add: [
        { text: 'CHAPTER 56. Of the Less Erroneous Pictures of Whales, and th', nth: 1 },
        { text: 'CHAPTER 57. Of Whales in Paint; in Teeth; in Wood; in Sheet-', nth: 1 },
        { text: 'CHAPTER 73. Stubb and Flask kill a Right Whale; and Then Hav', nth: 1 },
        { text: 'Epilogue', nth: 1 },
      ],
    },
  },
];

const ids = (chapter) => chapter.blocks.flatMap((b) => b.sentences.map((s) => s.id));
const firstChanged = (a, b) => a.chapters.findIndex((c, i) => c.fingerprint !== b.chapters[i]?.fingerprint);

let passed = 0;
let total = 0;
const check = (ok, label, detail = '') => {
  total += 1;
  passed += ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  — ${detail}`}`);
};

for (const { id, title, want, why, chapters } of CASES) {
  const raw = await load(id);
  const before = buildBook(raw, { source: 'gutenberg' });
  const after = buildBook(raw, { source: 'gutenberg' }, { chapters });

  check(after.stats.chapters === want, `${title.padEnd(16)} ${before.stats.chapters} → ${after.stats.chapters} chapters`,
    `want ${want}: ${why}`);
  check(after.corrections.unresolved.length === 0, `${title.padEnd(16)} every correction found its line`,
    JSON.stringify(after.corrections.unresolved));

  // Everything before the first correction is untouched, down to the ids.
  const changed = firstChanged(before, after);
  const untouched = before.chapters.slice(0, changed)
    .every((c, i) => JSON.stringify(ids(c)) === JSON.stringify(ids(after.chapters[i])));
  check(changed !== -1 && untouched, `${title.padEnd(16)} chapters before the first correction keep their ids`,
    `first changed chapter: ${changed}`);

  // Every heading's reference names that heading again: striking out all of
  // them, on top of the corrections already made, leaves no chapters at all.
  const roundTrip = buildBook(raw, { source: 'gutenberg' }, {
    chapters: { remove: [...(chapters.remove ?? []), ...after.chapters.filter((c) => c.heading).map((c) => c.heading)] },
  });
  check(roundTrip.chapters.length === 1 && roundTrip.corrections.unresolved.length === 0,
    `${title.padEnd(16)} heading references resolve back to their headings`,
    `${roundTrip.stats.chapters} left, ${roundTrip.corrections.unresolved.length} unresolved`);
}

// A struck-out heading is text, not debris: it must still be read and spoken.
{
  const raw = await load('1661');
  const book = buildBook(raw, { source: 'gutenberg' }, { chapters: CASES[0].chapters });
  const text = book.chapters[1].blocks.flatMap((b) => b.sentences.map((s) => s.text));
  check(text.includes('II.') && text.includes('III.'), 'struck-out headings stay in the text they belonged to');

  const none = buildBook(raw, { source: 'gutenberg' }, { chapters: { pattern: 'none' } });
  check(none.chapters.length === 1 && none.detectedBy === null, 'pattern "none" leaves one continuous text');

  const lost = buildBook(raw, { source: 'gutenberg' }, { chapters: { remove: [{ text: 'no such line', nth: 0 }] } });
  check(lost.corrections.unresolved.length === 1, 'a correction naming no line is reported, not ignored');
}

console.log(`\n${passed}/${total} passing`);
