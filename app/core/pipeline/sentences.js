// Sentence segmentation.
//
// Sentences are the unit everything downstream addresses: the reader
// highlights them, and the speech engine synthesizes them one at a time and
// stitches the clips with measured silence. A bad split is therefore audible
// -- breaking `"Stop!" he cried.` in two inserts a pause in the middle of a
// spoken sentence, which is exactly the artifact we're trying to remove.
//
// `Intl.Segmenter` (present in Node and iOS Safari) gets the easy cases right
// but breaks on the three things 19th-century prose is full of: courtesy
// titles, initials, and dialogue. So it generates candidates and we merge its
// bad splits back together.

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'sentence' });

// Abbreviations that end in a period without ending a sentence. ICU already
// handles `e.g.`, `i.e.` and friends; these are the ones it misses.
const ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Messrs', 'Dr', 'Prof', 'St', 'Ste', 'Sr', 'Jr',
  'Rev', 'Hon', 'Capt', 'Col', 'Gen', 'Lt', 'Sgt', 'Maj', 'Adm', 'Cmdr',
  'Gov', 'Pres', 'Supt', 'Mme', 'Mlle', 'Esq', 'Fr',
  'Mt', 'Ft', 'Ave', 'Blvd', 'Rd', 'Sq',
  'No', 'Vol', 'Ch', 'Chap', 'Sec', 'Fig', 'Pl', 'pp', 'ed', 'trans',
  'Inc', 'Co', 'Ltd', 'Bros', 'Dept', 'Univ', 'Jan', 'Feb', 'Mar', 'Apr',
  'Jun', 'Jul', 'Aug', 'Sept', 'Sep', 'Oct', 'Nov', 'Dec',
];

const ABBREV_RE = new RegExp(`(?:^|[\\s("'‘“])(?:${ABBREVIATIONS.join('|')})\\.$`, 'i');

// A lone capital followed by a period, as in `J. R. R. Tolkien`.
const INITIAL_RE = /(?:^|[\s("'‘“])[A-Z]\.$/;

function shouldMerge(previous, next) {
  const prev = previous.trimEnd();
  const rest = next.trimStart();
  if (!prev || !rest) return true;

  // Edited prose effectively never starts a sentence lowercase, so a lowercase
  // opening means ICU split inside one. This is the dialogue case:
  // `"Stop!" he cried.` and `"Well," said she.`
  if (/^[a-z]/.test(rest)) return true;

  if (ABBREV_RE.test(prev)) return true;
  if (INITIAL_RE.test(prev)) return true;

  return false;
}

/**
 * Split a block of prose into sentences.
 * @param {string} text  A single paragraph, already unwrapped.
 * @returns {string[]}
 */
export function splitSentences(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const out = [];
  for (const { segment } of SEGMENTER.segment(trimmed)) {
    if (out.length && shouldMerge(out[out.length - 1], segment)) {
      out[out.length - 1] += segment;
    } else {
      out.push(segment);
    }
  }

  return out.map((s) => s.trim()).filter(Boolean);
}
