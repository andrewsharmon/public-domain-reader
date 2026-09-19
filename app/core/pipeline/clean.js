// Strip each archive's packaging down to the author's actual words.

// Gutenberg wraps every book in a header and a license footer. The marker
// wording has drifted over the decades, so match the stable part loosely.
const PG_START = /^\s*\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*\s*$/im;
const PG_END = /^\s*\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*\s*$/im;

// Pre-2005 files used a very different sentinel.
const PG_SMALL_PRINT_END = /\*END\*THE SMALL PRINT!.*?\*END\*/is;
const PG_LEGACY_END = /^End of (?:the )?(?:Project Gutenberg|Project Gutenberg's).*$/im;

// Transcriber credits sit inside the markers but aren't part of the book.
const CREDITS = /^\s*(?:Produced by|Transcribed from|E-?text prepared by|Updated editions will)\b.*(?:\n(?!\n).*)*/gim;

function sliceBetween(text, startRe, endRes) {
  let body = text;

  const start = body.match(startRe);
  if (start) body = body.slice(start.index + start[0].length);
  else {
    const small = body.match(PG_SMALL_PRINT_END);
    if (small) body = body.slice(small.index + small[0].length);
  }

  for (const endRe of endRes) {
    const end = body.match(endRe);
    if (end) {
      body = body.slice(0, end.index);
      break;
    }
  }
  return body;
}

function normalize(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    // Gutenberg marks italics with underscores; they're noise to a reader and
    // actively harmful to a speech engine, which would try to pronounce them.
    .replace(/_([^_\n]{1,200}?)_/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

export function cleanGutenberg(text) {
  let body = sliceBetween(normalize(text), PG_START, [PG_END, PG_LEGACY_END]);
  body = body.replace(CREDITS, '');
  return body.trim();
}

// Internet Archive text is raw OCR of scanned pages, which brings its own
// debris: words broken across line ends by the printer's hyphenation, bare
// page numbers, and running heads repeated on every page.
export function cleanArchive(text) {
  return normalize(text)
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/^\s*\d{1,4}\s*$/gm, '')
    .replace(/^\s*[A-Z][A-Z \t.'-]{6,}\s*\d{0,4}\s*$/gm, (m) => (m.trim().length > 60 ? m : ''))
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function cleanWikisource(text) {
  return normalize(text)
    .replace(/^\s*(?:←|→|↑)\s*$/gm, '')
    .replace(/^\s*sister projects:.*$/gim, '')
    .trim();
}

const CLEANERS = {
  gutenberg: cleanGutenberg,
  archive: cleanArchive,
  wikisource: cleanWikisource,
};

export function clean(text, source) {
  return (CLEANERS[source] ?? normalize)(text);
}
