// Turn cleaned text into blocks -- the paragraphs and verse stanzas a reader
// sees and a speech engine pauses between.
//
// Archive text is hard-wrapped at ~70 columns, so a paragraph arrives as
// several short lines. Those have to be rejoined, or every line break becomes
// a spurious pause. But line breaks are *meaningful* in verse, so unwrapping
// everything would flatten poetry into prose. The two cases must be told apart.

const BLANK_LINE = /\n\s*\n/;

// Printers mark a scene change with a row of asterisks or a rule. It carries
// meaning -- time passes -- but it is not language: spoken aloud it becomes
// "asterisk asterisk asterisk", so it has to be recognised rather than read.
const SEPARATOR = /^[\s*·•—–\-_=~.]{3,}$/;

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// Verse gives itself away by being short and staying short: prose wrapped at
// 70 columns runs right up to the margin on every line but the last, while
// poetry stops wherever the line ends.
function looksLikeVerse(lines) {
  if (lines.length < 2) return false;

  const lengths = lines.map((l) => l.trimEnd().length);
  const body = lengths.slice(0, -1); // the last line is short either way
  if (median(body) >= 55) return false;

  // Indentation that varies line to line is another strong verse signal.
  const indents = new Set(lines.map((l) => l.match(/^ */)[0].length));
  return median(body) < 45 || indents.size > 1;
}

/**
 * @param {string} text  Cleaned book text.
 * @returns {{type: 'para'|'verse', text: string, lines?: string[]}[]}
 */
export function toBlocks(text) {
  const blocks = [];

  for (const chunk of text.split(BLANK_LINE)) {
    const lines = chunk.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;

    if (lines.length === 1 && SEPARATOR.test(lines[0])) {
      blocks.push({ type: 'break', text: lines[0].trim() });
    } else if (looksLikeVerse(lines)) {
      blocks.push({ type: 'verse', text: lines.map((l) => l.trim()).join('\n'), lines });
    } else {
      blocks.push({ type: 'para', text: lines.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ') });
    }
  }

  return blocks;
}
