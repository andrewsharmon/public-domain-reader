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

export function buildBook(rawText, meta) {
  // Chapter detection is heuristic and cannot be right on every book, so the
  // winning pattern travels with the result -- the reader surfaces it and
  // offers a manual override rather than pretending to certainty.
  const { pattern, chapters } = detectChapters(toBlocks(clean(rawText, meta.source)));

  let words = 0;

  const built = chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    frontMatter: chapter.frontMatter,
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

  return {
    ...meta,
    chapters: built,
    detectedBy: pattern,
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
