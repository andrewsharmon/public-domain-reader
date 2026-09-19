// Ranking regression tests.
//
// Relevance is the kind of thing that silently rots: a scoring tweak that
// fixes one query often demotes the obvious answer to another. These pin the
// cases where there is exactly one book a person could have meant.
//
//   node tests/search.js        (needs `npm run index` to have been run)

import { search } from '../server/sources/gutenberg.js';

const EXPECTED = [
  { q: 'alice in wonderland', id: '11', why: 'the work, not a retelling or dramatization' },
  { q: 'frankenstein', id: '84', why: 'the original, not a later edition' },
  { q: 'moby dick', id: '2701', why: 'the popular edition' },
  { q: 'pride and prejudice', id: '1342', why: 'plain title match' },
  { q: 'tale of two cities', id: '98', why: 'partial title' },
  // Genuinely ambiguous: several Doyle collections are equally valid answers,
  // and the top two score within a couple of points. The requirement is that
  // a canonical Holmes collection wins, not which one.
  { q: 'sherlock holmes', ids: ['1661', '108', '2350', '834', '221'], why: 'a canonical Doyle collection' },
  { q: 'shelley frankenstein', id: '84', why: 'author plus title' },
  { q: 'war and peace', id: '2600', why: 'plain title match' },
];

let passed = 0;
for (const { q, id, ids, why } of EXPECTED) {
  const wanted = ids ?? [id];
  const results = await search(q, { limit: 5 });
  const top = results[0];
  const rank = results.findIndex((r) => wanted.includes(r.sourceId));
  const ok = wanted.includes(top?.sourceId);
  passed += ok;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${q.padEnd(22)} → ${(top?.title ?? '(nothing)').slice(0, 42).padEnd(44)}` +
    `${ok ? '' : `want ${wanted.map((w) => `#${w}`).join(' or ')}` +
      `${rank >= 0 ? ` (found at ${rank + 1})` : ' (not in top 5)'} — ${why}`}`,
  );
}
console.log(`\n${passed}/${EXPECTED.length} passing`);
