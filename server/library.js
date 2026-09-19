// The library: books saved to disk as real files you can open.
//
// This is deliberately separate from the fetch cache. The cache is disposable
// and keyed by hash, existing only to avoid re-downloading during a session.
// The library is the opposite: permanent, human-readable, and organized so
// the files are useful outside this app -- an offline TTS render reads
// `book.json`, and `book.txt` is just the book, openable in any editor.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildBook } from '../app/core/pipeline/index.js';
import { clean } from '../app/core/pipeline/clean.js';

export const LIBRARY_DIR = path.join(process.cwd(), 'library');

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
  const book = buildBook(rawText, meta);
  const slug = slugFor(meta);
  const dir = path.join(LIBRARY_DIR, slug);

  await mkdir(dir, { recursive: true });

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
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    ),
  ]);

  return { slug, dir, stats: book.stats, detectedBy: book.detectedBy };
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
  const dir = path.join(LIBRARY_DIR, slug, 'audio');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // nothing rendered for this book
  }

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
        })),
      });
    } catch {
      // A directory without a readable sync map isn't a finished render.
    }
  }
  return found;
}
