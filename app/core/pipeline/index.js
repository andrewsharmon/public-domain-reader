// The shared spine: raw archive bytes in, a normalized Book out.
//
// Both other prongs address this structure. The reader renders it; the speech
// engine synthesizes one sentence at a time and stitches the clips, then keys
// the sync map by sentence id so highlighting stays exact.

import { clean } from './clean.js';
import { toBlocks } from './blocks.js';
import { detectChapters } from './chapters.js';
import { splitSentences } from './sentences.js';

/**
 * Stable, human-readable address for a sentence: `c5.b12.s2`.
 * The speech renderer uses these as sync-map keys and the reader uses them as
 * scroll anchors, so they must not shift between runs on the same text.
 */
const sentenceId = (c, b, s) => `c${c}.b${b}.s${s}`;

// Debris that survives cleaning and reaches the sentence splitter as its own
// "sentence": a stray bracket from a footnote, a lone ellipsis standing in for
// omitted text, a rule of punctuation. There is nothing in it to pronounce --
// a speech engine given `_]` has no phonemes to produce and fails outright --
// and nothing to read either, so it is not a sentence.
const hasSpeakableContent = (text) => /[\p{L}\p{N}]/u.test(text);

/** The blocks chapter detection works over, for resolving a block the reader pointed at. */
export const blocksOf = (rawText, source) => toBlocks(clean(rawText, source));

// 32-bit FNV-1a, which its authors placed in the public domain, plus the
// length. It runs the same in Node and the browser, where crypto.subtle would
// make building a Book asynchronous, and it only has to notice change, not
// resist tampering: a changed chapter that collides by chance is about one in
// four billion.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return `${(h >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/**
 * A hash of exactly what the speech renderer reads from a chapter.
 *
 * A render records it per chapter, so audio made from a chapter that has
 * since changed -- a corrected boundary, a better sentence split -- reads as
 * stale instead of playing against text it no longer matches. Sentence ids
 * are part of it, so a chapter whose index shifted is stale too: its timings
 * are keyed by ids that now belong to a different chapter.
 */
export const chapterFingerprint = (chapter) =>
  hash(JSON.stringify({ frontMatter: chapter.frontMatter, blocks: chapter.blocks }));

/**
 * @param {string} rawText    Text exactly as the archive served it.
 * @param {object} meta       Normalized Book metadata from the source adapter.
 * @param {object} [corrections]  Saved with the book by the reader; see chapters.js.
 */
export function buildBook(rawText, meta, corrections = {}) {
  // Chapter detection is heuristic and cannot be right on every book, so the
  // winning pattern travels with the result, and the reader can correct it
  // rather than the pipeline pretending to certainty.
  const { pattern, unresolved, chapters } = detectChapters(blocksOf(rawText, meta.source), corrections.chapters);

  let words = 0;

  const built = chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    frontMatter: chapter.frontMatter,
    heading: chapter.heading,
    firstBlock: chapter.firstBlock,
    ...(chapter.marked ? { marked: true } : {}),
    blocks: chapter.blocks.map((block, b) => {
      // A scene break has no words to say; it survives as a block so the
      // reader can draw it and the speech engine can pause on it.
      if (block.type === 'break') return { type: 'break', sentences: [] };

      // Verse is spoken and displayed line by line; its line breaks are
      // authorial, so they must not be re-flowed into sentences.
      const units = block.type === 'verse' ? block.lines.map((l) => l.trim()) : splitSentences(block.text);

      return {
        type: block.type,
        // Indices come from the unfiltered list, so dropping unspeakable
        // debris never shifts the ids of the sentences around it.
        sentences: units
          .map((text, s) => ({ id: sentenceId(chapter.index, b, s), text }))
          .filter((sentence) => {
            if (!hasSpeakableContent(sentence.text)) return false;
            words += sentence.text.split(/\s+/).length;
            return true;
          }),
      };
    }),
  }));

  for (const chapter of built) chapter.fingerprint = chapterFingerprint(chapter);

  return {
    ...meta,
    chapters: built,
    detectedBy: pattern,
    // The corrections as applied, including any that no longer match a line
    // in the text, so the reader can say so instead of silently ignoring them.
    corrections: corrections.chapters ? { ...corrections.chapters, unresolved } : null,
    stats: {
      chapters: built.filter((c) => !c.frontMatter).length,
      blocks: built.reduce((n, c) => n + c.blocks.length, 0),
      sentences: built.reduce((n, c) => n + c.blocks.reduce((m, b) => m + b.sentences.length, 0), 0),
      words,
      // A rough listening estimate at an ordinary narration pace, useful for
      // warning before committing to a long offline render.
      minutesAt160wpm: Math.round(words / 160),
    },
  };
}
