// The library: books saved to disk as real files you can open.
//
// This is deliberately separate from the fetch cache. The cache is disposable
// and keyed by hash, existing only to avoid re-downloading during a session.
// The library is the opposite: permanent, human-readable, and organized so
// the files are useful outside this app -- an offline TTS render reads
// `book.json`, and `book.txt` is just the book, openable in any editor.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { blocksOf, buildBook, chapterFingerprint } from '../app/core/pipeline/index.js';
import { blockRef, MAX_HEADING_CHARS, PATTERN_NAMES, sameRef } from '../app/core/pipeline/chapters.js';
import { clean } from '../app/core/pipeline/clean.js';

export const LIBRARY_DIR = path.join(process.cwd(), 'library');

// Corrections the reader has made to a book's structure. A file of its own
// rather than a field in meta.json, because saving rewrites meta.json from
// whatever metadata the caller had -- a search result knows nothing about
// corrections -- and a correction must survive both re-saving and reparsing.
const CORRECTIONS = 'corrections.json';

/** A book's folder, refusing anything that would resolve outside the library. */
export function bookDir(slug) {
  if (!slug || slug !== path.basename(slug) || slug.startsWith('.')) {
    throw Object.assign(new Error(`not a book: ${slug}`), { status: 400 });
  }
  return path.join(LIBRARY_DIR, slug);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Short, stable source codes keep folder names readable: `frankenstein-pg84`
// rather than a hash or a bare title that two archives might both claim.
const CODES = { gutenberg: 'pg', archive: 'ia', wikisource: 'ws' };

function slugify(text, max = 60) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
    .replace(/-$/, '');
}

export function slugFor(book) {
  const author = book.authors?.[0]?.split(',')[0] ?? '';
  const name = slugify([author, book.title].filter(Boolean).join(' '));
  // The source id is always appended, so saving the same book twice is
  // idempotent and two editions of one title can coexist.
  return `${name || 'untitled'}-${CODES[book.source] ?? book.source}${slugify(String(book.sourceId), 20)}`;
}

/**
 * Parse an already-fetched book and write it to the library.
 * @param {string} rawText    Text exactly as the archive served it.
 * @param {object} meta       Normalized Book metadata from the source adapter.
 */
export async function save(rawText, meta) {
  const slug = slugFor(meta);
  const dir = path.join(LIBRARY_DIR, slug);
  const book = buildBook(rawText, meta, await readJson(path.join(dir, CORRECTIONS), {}));

  await mkdir(dir, { recursive: true });
  await adoptUnfingerprintedRenders(dir);

  await Promise.all([
    // The book as prose: no license boilerplate, no OCR debris, readable
    // anywhere. This is the file to hand to another tool.
    writeFile(path.join(dir, 'book.txt'), clean(rawText, meta.source), 'utf8'),

    // The parsed structure the reader renders and the speech renderer speaks,
    // including the stable sentence ids its sync map is keyed by.
    writeFile(path.join(dir, 'book.json'), JSON.stringify(book, null, 2), 'utf8'),

    writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        {
          title: meta.title,
          authors: meta.authors,
          source: meta.source,
          sourceId: meta.sourceId,
          sourceUrl: meta.sourceUrl,
          languages: meta.languages,
          detectedBy: book.detectedBy,
          stats: book.stats,
          // Rebuilding a saved book -- a reparse, a chapter correction -- is
          // not saving it again, and must not move it to the top of the shelf.
          savedAt: meta.savedAt ?? new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    ),
  ]);

  return { slug, dir, stats: book.stats, detectedBy: book.detectedBy };
}

// Renders made before chapters carried fingerprints have nothing to check
// against, and the book.json they were made from is about to be replaced.
// Stamp each chapter with the fingerprint of the structure it is being
// replaced from, while that is still on disk, so it reads as current until
// its chapter actually changes -- neither trusted forever nor thrown away.
//
// A chapter whose title no longer matches was already out of step with the
// book before this rebuild, so it is stamped as unmatched, and reads as stale.
async function adoptUnfingerprintedRenders(dir) {
  const previous = await readJson(path.join(dir, 'book.json'), null);
  if (!previous) return;

  let profiles;
  try {
    profiles = await readdir(path.join(dir, 'audio'), { withFileTypes: true });
  } catch {
    return; // never rendered
  }

  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const file = path.join(dir, 'audio', profile.name, 'sync.json');
    const sync = await readJson(file, null);
    if (!sync) continue;

    let changed = false;
    for (const chapter of sync.chapters ?? []) {
      if (chapter.fingerprint) continue;
      const was = previous.chapters.find((c) => c.index === chapter.index);
      chapter.fingerprint = was && (was.title ?? null) === (chapter.title ?? null)
        ? was.fingerprint ?? chapterFingerprint(was)
        : 'unmatched';
      changed = true;
    }
    if (changed) await writeFile(file, JSON.stringify(sync, null, 2), 'utf8');
  }
}

/**
 * Correct one book's chapters, then rebuild it from its original text, which
 * `loadText(source, sourceId)` supplies.
 *
 *   { pattern: 'auto' | 'named' | 'numeral' | 'caps' | 'none' }
 *   { ref, startsChapter }                    a heading the book already names
 *   { chapter, block, text, startsChapter }   a line the reader pointed at
 *   { reset: true }
 *
 * Marking and unmarking are toggles over two lists, so undoing a correction
 * removes it rather than stacking an opposite one on top.
 */
export async function correctChapters(slug, edit, loadText) {
  const dir = bookDir(slug);
  const meta = await readJson(path.join(dir, 'meta.json'), null);
  if (!meta) throw Object.assign(new Error(`not in the library: ${slug}`), { status: 404 });

  // The original text, not book.txt: a rebuild runs the whole pipeline, and
  // cleaning is part of it.
  const { text: rawText } = await loadText(meta.source, meta.sourceId);

  const file = path.join(dir, CORRECTIONS);
  const corrections = await readJson(file, {});
  const chapters = { remove: [], add: [], ...corrections.chapters };

  if (edit.reset) {
    chapters.remove = [];
    chapters.add = [];
    delete chapters.pattern;
  } else if (edit.pattern) {
    if (![...PATTERN_NAMES, 'auto', 'none'].includes(edit.pattern)) {
      throw Object.assign(new Error(`unknown pattern: ${edit.pattern}`), { status: 400 });
    }
    if (edit.pattern === 'auto') delete chapters.pattern;
    else chapters.pattern = edit.pattern;
  } else if (edit.ref) {
    const { text, nth } = edit.ref;
    if (typeof text !== 'string' || !Number.isInteger(nth)) {
      throw Object.assign(new Error('a heading is named by { text, nth }'), { status: 400 });
    }
    toggle(chapters, { text, nth }, Boolean(edit.startsChapter));
  } else {
    toggle(chapters, await pointedAt(dir, edit, rawText, meta.source), true);
  }

  const empty = !chapters.pattern && !chapters.remove.length && !chapters.add.length;
  if (empty) delete corrections.chapters;
  else corrections.chapters = chapters;

  if (Object.keys(corrections).length) await writeFile(file, JSON.stringify(corrections, null, 2), 'utf8');
  else await rm(file, { force: true });

  return save(rawText, meta);
}

// Saying a line does or does not start a chapter first cancels a correction
// that said the opposite; only if there was none does it record a new one.
function toggle(chapters, ref, startsChapter) {
  const [undo, record] = startsChapter ? ['remove', 'add'] : ['add', 'remove'];
  const before = chapters[undo].length;
  chapters[undo] = chapters[undo].filter((r) => !sameRef(r, ref));
  if (chapters[undo].length === before && !chapters[record].some((r) => sameRef(r, ref))) {
    chapters[record].push(ref);
  }
}

// Turn "block 4 of chapter 12" into a reference that survives reparsing.
//
// The reader only knows the book.json it loaded, so the position is checked
// against the text before anything is written: if the pipeline has changed
// since the book was last built, the same position may hold a different line.
async function pointedAt(dir, { chapter, block, text }, rawText, source) {
  const book = await readJson(path.join(dir, 'book.json'), null);
  const start = book?.chapters?.[chapter]?.firstBlock;
  const blocks = blocksOf(rawText, source);
  const index = start + block;
  const target = Number.isInteger(index) ? blocks[index] : undefined;

  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!target || !text || !squash(target.text).includes(squash(text))) {
    throw Object.assign(new Error('the book has changed since it was opened; reload and try again'), { status: 409 });
  }
  if (target.type === 'break' || target.text.length > MAX_HEADING_CHARS) {
    throw Object.assign(new Error('only a short line can start a chapter, because it becomes the title'), { status: 400 });
  }
  return blockRef(blocks, index);
}

export async function list() {
  let entries;
  try {
    entries = await readdir(LIBRARY_DIR, { withFileTypes: true });
  } catch {
    return []; // nothing saved yet
  }

  const books = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(LIBRARY_DIR, entry.name, 'meta.json'), 'utf8'));
      books.push({ slug: entry.name, ...meta });
    } catch {
      // A folder without readable metadata isn't a book we put there.
    }
  }
  return books.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
}

/**
 * Rendered audio available for a book.
 *
 * A render is a directory of chapter audio plus the sync map that pairs it
 * with the text. One book can hold several, because trying a different voice
 * or speed means rendering again rather than editing anything.
 */
export async function renders(slug) {
  const dir = path.join(bookDir(slug), 'audio');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // nothing rendered for this book
  }

  // Each rendered chapter is checked against the chapter as it stands now. A
  // chapter that has changed since -- its boundaries corrected, its sentences
  // split differently -- would play, but every timing would point at the
  // wrong sentence.
  const book = await readJson(path.join(bookDir(slug), 'book.json'), { chapters: [] });
  const current = new Map(book.chapters.map((c) => [c.index, c.fingerprint]));
  const stale = (c) => !current.has(c.index)
    || Boolean(c.fingerprint && current.get(c.index) && c.fingerprint !== current.get(c.index));

  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const sync = JSON.parse(await readFile(path.join(dir, entry.name, 'sync.json'), 'utf8'));
      found.push({
        profile: entry.name,
        voice: sync.voice,
        speed: sync.speed,
        effectiveSpeed: sync.effectiveSpeed ?? sync.speed,
        renderedAt: sync.renderedAt,
        chapters: (sync.chapters ?? []).map((c) => ({
          index: c.index,
          file: c.file,
          duration: c.duration,
          stale: stale(c),
        })),
      });
    } catch {
      // A directory without a readable sync map isn't a finished render.
    }
  }
  return found;
}
