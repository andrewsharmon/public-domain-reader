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

// Two headings back to back are a title and its subtitle, not two chapters:
// `BOOK I` directly above `PERSONS OF THE DIALOGUE.` is one division. Merging
// them has to happen before the empty-chapter check, which would otherwise
// throw away the real heading because nothing sits between the two.
//
// Only pairs merge. A longer run of adjacent headings is a contents list, and
// that is someone else's job.
function mergeAdjacent(blocks, headings) {
  const kept = [];
  for (let i = 0; i < headings.length; i += 1) {
    const isPair = headings[i + 1] === headings[i] + 1 && headings[i + 2] !== headings[i] + 2;
    kept.push(headings[i]);
    if (isPair) i += 1; // swallow the subtitle
  }
  return kept;
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

// The heading's own text, plus a subtitle block if one was merged into it.
function headingTitle(blocks, start, end) {
  const lines = blocks[start].text.split('\n').map((l) => l.trim()).filter(Boolean);
  const next = blocks[start + 1];
  if (next && start + 1 < end && next.type !== 'verse' && !next.text.includes('\n')
      && next.text.length <= 70 && /^[^a-z]*[A-Z][A-Z][^a-z]*$/.test(next.text)) {
    lines.push(next.text.trim());
  }
  return lines.join(' — ');
}

export const PATTERN_NAMES = PATTERNS.map((p) => p.name);

const headingsFor = (blocks, pattern) =>
  dropEmpty(blocks, mergeAdjacent(blocks, dropTableOfContents(blocks, candidates(blocks, pattern))));

// ---------------------------------------------------------------- corrections
//
// Detection is right on most books and close on the rest, and the rest need a
// person: an all-capitals newspaper headline quoted inside a story is
// structurally identical to the story's title. So a book can carry
// corrections -- force a pattern, say a detected heading is not one, or say a
// line detection missed is -- and they are applied here, inside the pipeline,
// so that everything downstream (the reader, the sentence ids, a render) sees
// one structure rather than a raw one and a corrected one.

// A correction has to outlive re-parsing, because the pipeline keeps
// improving and `npm run reparse` reruns it over every saved book. A block
// index would be simplest, but any change to cleaning shifts every index
// after it. A heading's own words do not move, so a block is named by its
// opening text and which occurrence of that text it is: the third `II.` in a
// story collection, say.
const REF_LENGTH = 60;
const refText = (block) => block.text.replace(/\s+/g, ' ').trim().slice(0, REF_LENGTH);

function blockRefs(blocks) {
  const seen = new Map();
  return blocks.map((block) => {
    const text = refText(block);
    const nth = seen.get(text) ?? 0;
    seen.set(text, nth + 1);
    return { text, nth };
  });
}

export const sameRef = (a, b) => a.text === b.text && (a.nth ?? 0) === (b.nth ?? 0);

/** The stable reference for the block at `index`. */
export const blockRef = (blocks, index) => blockRefs(blocks.slice(0, index + 1))[index];

// A block marked by hand becomes the chapter's title and leaves the text, so
// only a line short enough to be a title may be marked. Long enough for
// Moby-Dick's wordiest headings, which run past the 70 characters automatic
// detection allows.
export const MAX_HEADING_CHARS = 200;

/**
 * @param {object[]} blocks
 * @param {object} [corrections]
 * @param {string} [corrections.pattern]  force one pattern, or `none` for no chapters
 * @param {{text: string, nth: number}[]} [corrections.remove]  detected headings that are not chapters
 * @param {{text: string, nth: number}[]} [corrections.add]     lines that start a chapter detection missed
 */
export function detectChapters(blocks, corrections = {}) {
  let best = { headings: [], score: -Infinity, pattern: null };

  for (const pattern of PATTERNS) {
    const headings = headingsFor(blocks, pattern);
    const value = score(blocks, headings);
    if (value > best.score) best = { headings, score: value, pattern: pattern.name };
  }

  let pattern = best.score === -Infinity ? null : best.pattern;
  let headings = pattern ? best.headings : [];

  // A forced pattern is taken as it comes. The score exists to choose between
  // patterns, and the reader has already chosen.
  const forced = PATTERNS.find((p) => p.name === corrections.pattern);
  if (forced) {
    pattern = forced.name;
    headings = headingsFor(blocks, forced);
  } else if (corrections.pattern === 'none') {
    pattern = null;
    headings = [];
  }

  const refs = blockRefs(blocks);
  const unresolved = [];
  const locate = (ref) => {
    const index = refs.findIndex((r) => sameRef(r, ref));
    if (index === -1) unresolved.push(ref);
    return index;
  };

  // A removed heading's block is not discarded: it falls into the chapter
  // before it as ordinary text, because it was text all along -- a headline
  // the character is reading, a numbered section inside a story.
  const removed = new Set((corrections.remove ?? []).map(locate));
  const added = new Set((corrections.add ?? []).map(locate).filter((i) => i !== -1));
  headings = [...new Set([...headings.filter((h) => !removed.has(h)), ...added])]
    .filter((h) => blocks[h].type !== 'break')
    .sort((a, b) => a - b);

  if (!headings.length) {
    return {
      pattern: null,
      unresolved,
      chapters: [{ index: 0, title: null, frontMatter: false, heading: null, firstBlock: 0, blocks }],
    };
  }

  const chapters = [];
  if (headings[0] > 0) {
    chapters.push({
      index: 0,
      title: 'Front matter',
      frontMatter: true,
      heading: null,
      firstBlock: 0,
      blocks: blocks.slice(0, headings[0]),
    });
  }

  headings.forEach((start, i) => {
    const end = headings[i + 1] ?? blocks.length;
    chapters.push({
      index: chapters.length,
      // Keep the subtitle when the heading block carried one.
      title: headingTitle(blocks, start, end),
      frontMatter: false,
      // How a correction names this heading, and where the chapter's text
      // begins in the whole book -- together, enough for the reader to point
      // at any line and have the server find it again.
      heading: refs[start],
      firstBlock: start + 1,
      ...(added.has(start) ? { marked: true } : {}),
      blocks: blocks.slice(start + 1, end),
    });
  });

  return { pattern, unresolved, chapters };
}
