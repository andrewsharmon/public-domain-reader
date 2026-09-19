// Chapter detection.
//
// There is no markup in a plain text book, so a chapter heading is only ever
// a short line that looks like one. Several failure modes matter, and all of
// them showed up in the test corpus:
//
//   - the table of contents lists the same strings as the real headings
//   - stray capitalised lines inside a story masquerade as headings
//   - a heading and its subtitle often share one block, with no blank line
//   - a weak pattern can match a few times in a book whose real headings use
//     a different style entirely
//
// The last one is why this doesn't simply try patterns in priority order and
// take the first that clears a threshold. It builds a candidate set from every
// pattern and scores them, because the decisive signal isn't which pattern
// matched -- it's that real chapters carve the book into roughly even pieces.

const NUMBER = String.raw`(?:\d{1,3}|[IVXLCDM]{1,7}|the\s+\w+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)`;

// Named divisions. `Letter` and `Adventure` are here because epistolary novels
// and the Holmes collection use them as their top-level division.
const DIVISION = 'chapter|letter|book|part|canto|act|scene|volume|stave|section|adventure|story|tale|episode|fytte|night';

const PATTERNS = [
  { name: 'named', re: new RegExp(String.raw`^\s*(?:${DIVISION})\s+${NUMBER}\b`, 'i'), multiline: true },
  // A numeral leading a line, alone or followed by a title:
  // `I.`, `1.`, `I. A SCANDAL IN BOHEMIA`.
  //
  // The punctuation is not optional, because `I` is itself a roman numeral --
  // without it, every first-person sentence in the book ("I am glad my case
  // is not serious!") parses as a chapter heading.
  {
    name: 'numeral',
    re: /^\s*(?:[IVXLCDM]{1,7}|\d{1,3})(?:\s*[.)]?\s*$|\s*[.):\u2013\u2014-]\s+\S.*$)/,
    multiline: true,
  },
  // Fully capitalised titles, the usual style for story collections. Unlike
  // the others this must stand alone on its line: a capitalised line trailed
  // by a date or byline is a quoted headline inside the prose, not a heading.
  { name: 'caps', re: /^[^a-z]*[A-Z][A-Z][^a-z]*$/, multiline: false },
];

// Quoted capitals are never headings -- they are letter signatures and shouted
// dialogue, which a collection like the Holmes stories is full of:
// `"BALLARAT."`, `"'ROBERT ST. SIMON.'`, `"VIOLET HUNTER."`.
const OPENS_QUOTED = /^\s*["'‘“]/;

// A heading may share its block with a subtitle -- Gutenberg often sets
// `CHAPTER I.` and `Down the Rabbit-Hole` on consecutive lines with no blank
// line between, which also makes the block look like verse.
function headingText(block, multiline) {
  const lines = block.text.split('\n');
  if (lines.length > (multiline ? 3 : 1) || block.text.length > 150) return null;
  if (lines[0].trim().length > 70) return null;
  if (OPENS_QUOTED.test(lines[0])) return null;
  return lines;
}

function candidates(blocks, { re, multiline }) {
  const found = [];
  blocks.forEach((block, i) => {
    const lines = headingText(block, multiline);
    if (lines && re.test(lines[0])) found.push(i);
  });
  return found;
}

// Characters of content between a heading and the next one.
function gaps(blocks, headings) {
  return headings.map((start, i) => {
    const end = headings[i + 1] ?? blocks.length;
    let size = 0;
    for (let j = start + 1; j < end; j += 1) size += blocks[j].text.length;
    return size;
  });
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

// A table of contents is a run of headings with almost nothing between them,
// because each entry's "content" is just the next entry.
function dropTableOfContents(blocks, headings) {
  const sparse = gaps(blocks, headings).map((g) => g < 200);
  let runStart = 0;
  for (let i = 0; i <= sparse.length; i += 1) {
    if (sparse[i]) continue;
    if (i - runStart >= 3) return headings.filter((_, j) => j < runStart || j > i);
    runStart = i + 1;
  }
  return headings;
}

// A heading with no prose after it is a quoted headline sitting inside a
// chapter, not the start of one. This floor is absolute rather than relative
// to the other chapters, so a genuinely short chapter still survives.
function dropEmpty(blocks, headings) {
  const sizes = gaps(blocks, headings);
  return headings.filter((_, i) => sizes[i] >= 100);
}

// Real chapters divide a book into comparable pieces. Reward finding more of
// them, but penalise a set whose pieces vary wildly in size -- that's the
// signature of a pattern matching things that aren't headings.
function score(blocks, headings) {
  if (headings.length < 3) return -Infinity;

  const sizes = gaps(blocks, headings);

  // The typical chapter must actually hold a chapter's worth of prose. This is
  // what stops a short story being diced into ten "chapters" by scene breaks,
  // and it uses the median so one short chapter can't sink a real set.
  if (median(sizes) < 1500) return -Infinity;

  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;

  const sd = Math.sqrt(sizes.reduce((a, g) => a + (g - mean) ** 2, 0) / sizes.length);
  const evenness = 1 / (1 + sd / mean);

  // Prefer sets that account for most of the book rather than a stray corner.
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  const coverage = sizes.reduce((a, b) => a + b, 0) / total;

  return Math.log2(headings.length) * evenness * coverage;
}

export function detectChapters(blocks) {
  let best = { headings: [], score: -Infinity, pattern: null };

  for (const pattern of PATTERNS) {
    const headings = dropEmpty(blocks, dropTableOfContents(blocks, candidates(blocks, pattern)));
    const value = score(blocks, headings);
    if (value > best.score) best = { headings, score: value, pattern: pattern.name };
  }

  const headings = best.score === -Infinity ? [] : best.headings;

  if (!headings.length) {
    return { pattern: null, chapters: [{ index: 0, title: null, frontMatter: false, blocks }] };
  }

  const chapters = [];
  if (headings[0] > 0) {
    chapters.push({ index: 0, title: 'Front matter', frontMatter: true, blocks: blocks.slice(0, headings[0]) });
  }

  headings.forEach((start, i) => {
    const end = headings[i + 1] ?? blocks.length;
    chapters.push({
      index: chapters.length,
      // Keep the subtitle when the heading block carried one.
      title: blocks[start].text.split('\n').map((l) => l.trim()).filter(Boolean).join(' — '),
      frontMatter: false,
      blocks: blocks.slice(start + 1, end),
    });
  });

  return { pattern: best.pattern, chapters };
}
