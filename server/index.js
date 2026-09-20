// The one process behind the whole project.
//
// It serves the app AND proxies the book archives, which means the browser is
// always same-origin and the CORS problem simply doesn't arise -- Project
// Gutenberg sends no CORS header on its text files, so a purely static build
// could never download them.
//
// It binds 0.0.0.0 so an iPhone on the same Wi-Fi can read from the Mac.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

import * as cache from './cache.js';
import * as library from './library.js';
import { LIBRARY_DIR } from './library.js';
import * as gutenberg from './sources/gutenberg.js';
import * as archive from './sources/archive.js';
import * as wikisource from './sources/wikisource.js';

const SOURCES = { gutenberg, archive, wikisource };

// These archives are volunteer-run and their latency is erratic -- Gutendex
// has answered the same query in 0.2s and in 26s minutes apart. Without a
// deadline one slow archive hangs the whole search, because the fan-out can
// only finish when its slowest member does.
const SEARCH_TIMEOUT_MS = 12_000;
// Downloads are whole books, so they get far longer.
const FETCH_TIMEOUT_MS = 120_000;
const PORT = Number(process.env.PORT ?? 8080);
const APP_DIR = path.join(process.cwd(), 'app');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': MIME['.json'] });
  res.end(JSON.stringify(body));
};

// Fan out across every requested source at once. One archive being down or
// slow must never take out the whole search, so failures come back as data
// alongside the results rather than as a rejected request.
// Which sources exist, and whether each answers from a local mirror or over
// the network. The UI shows this so a slow search is legible rather than
// mysterious.
async function handleSources(res) {
  const sources = await Promise.all(
    Object.values(SOURCES).map(async (s) => {
      try {
        return { id: s.id, label: s.label, ...(await s.status()) };
      } catch (err) {
        return { id: s.id, label: s.label, mode: 'unknown', note: err.message };
      }
    }),
  );
  json(res, 200, sources);
}

async function handleSearch(url, res) {
  const query = url.searchParams.get('q')?.trim();
  if (!query) return json(res, 400, { error: 'missing ?q=' });

  const names = (url.searchParams.get('sources') ?? Object.keys(SOURCES).join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s in SOURCES);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50);

  const timings = names.map(() => Date.now());
  const settled = await Promise.allSettled(
    names.map(async (n, i) => {
      const value = await SOURCES[n].search(query, {
        limit,
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      timings[i] = Date.now() - timings[i];
      return value;
    }),
  );

  const status = settled.map((r, i) => {
    if (r.status === 'fulfilled') {
      return { source: names[i], ok: true, count: r.value.length, ms: timings[i] };
    }
    const timedOut = r.reason?.name === 'TimeoutError' || r.reason?.name === 'AbortError';
    return {
      source: names[i],
      ok: false,
      timedOut,
      ms: Date.now() - timings[i],
      message: timedOut
        ? `no response within ${SEARCH_TIMEOUT_MS / 1000}s`
        : r.reason?.message ?? String(r.reason),
    };
  });

  const results = mergeRanked(settled, names);
  json(res, 200, {
    query,
    count: results.length,
    results,
    sources: status,
    errors: status.filter((s) => !s.ok),
  });
}

// Merge results from archives whose scores are not comparable.
//
// Raw popularity cannot be sorted across sources: the Internet Archive's
// download counts dwarf Gutenberg's, so IA items that merely matched a word
// outranked the actual book. What does compare is each result's *rank within
// its own source*, weighted by how good that source's text tends to be.
const SOURCE_QUALITY = {
  gutenberg: 1.0, // proofread transcriptions, the best text available
  wikisource: 0.85, // human-transcribed, but structurally awkward
  archive: 0.55, // OCR of scans: vast, noisy, and full of non-books
};

function mergeRanked(settled, names) {
  const merged = [];
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const weight = SOURCE_QUALITY[names[i]] ?? 0.5;
    const total = r.value.length || 1;
    r.value.forEach((book, rank) => {
      merged.push({ ...book, score: (1 - rank / total) * weight });
    });
  });
  return merged.sort((a, b) => b.score - a.score);
}



// Download a book, or return the copy already on disk. Shared by the raw text
// endpoint and by saving to the library, so a book is never fetched twice.
async function loadText(source, sourceId) {
  const hit = await cache.read(source, sourceId);
  if (hit) return { ...hit, cached: true };

  const payload = await SOURCES[source].fetchText(sourceId, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await cache.write(source, sourceId, payload);
  return { ...payload, cached: false };
}

// Wikisource navigation pages aren't a failure so much as a question: which
// edition did you mean? Pass the options through rather than erroring out.
function sendFetchError(res, err) {
  if (err.code === 'AMBIGUOUS') {
    return json(res, 409, { error: err.message, code: err.code, choices: err.choices });
  }
  return json(res, 502, { error: err.message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleText(url, res) {
  const source = url.searchParams.get('source');
  const sourceId = url.searchParams.get('id');
  if (!source || !sourceId) return json(res, 400, { error: 'missing ?source= and ?id=' });
  if (!(source in SOURCES)) return json(res, 404, { error: `unknown source: ${source}` });

  try {
    json(res, 200, await loadText(source, sourceId));
  } catch (err) {
    sendFetchError(res, err);
  }
}

// Save a book to the library as real files on disk.
async function handleSave(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const { source, id: sourceId } = body;
  if (!source || !sourceId) return json(res, 400, { error: 'missing source and id' });
  if (!(source in SOURCES)) return json(res, 404, { error: `unknown source: ${source}` });

  try {
    const fetched = await loadText(source, sourceId);
    // Prefer the richer metadata the search result carried, falling back to
    // whatever the fetch itself reported.
    const meta = { ...fetched.book, ...body.meta, source, sourceId };
    const saved = await library.save(fetched.text, meta);
    json(res, 200, { ok: true, ...saved });
  } catch (err) {
    sendFetchError(res, err);
  }
}

// Byte-range support, which audio needs and ordinary page assets do not.
//
// Without it a browser cannot seek: asking for a position it has not buffered
// gets the whole file from byte zero, and the player snaps back to the start.
// Tapping a sentence to jump there is the whole point of the sync map, so this
// is not optional.
async function serveRange(req, res, file, size, type) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!match) {
    res.writeHead(200, {
      'content-type': type,
      'content-length': size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
    return;
  }

  const [, rawStart, rawEnd] = match;
  const start = rawStart ? Number(rawStart) : 0;
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;

  if (start >= size || start > end) {
    res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }

  res.writeHead(206, {
    'content-type': type,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${size}`,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  });
  createReadStream(file, { start, end }).pipe(res);
}

const RANGED = new Set(['.m4a', '.mp3', '.wav']);

async function serveStatic(pathname, res, req) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  // Saved books are served straight off disk, so the reader fetches the same
  // book.json an offline render reads. They live under their own URL prefix:
  // `library/` would collide with the app's own app/library/ module.
  const inBooks = rel.startsWith('books/');
  const dir = inBooks ? LIBRARY_DIR : APP_DIR;
  const file = path.join(dir, inBooks ? rel.slice('books/'.length) : rel);

  // Never let a crafted path escape the directory it belongs to.
  if (!file.startsWith(dir)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  const type = MIME[path.extname(file)] ?? 'application/octet-stream';

  if (RANGED.has(path.extname(file))) {
    try {
      const info = await stat(file);
      return await serveRange(req, res, file, info.size, type);
    } catch {
      res.writeHead(404, { 'content-type': MIME['.html'] }).end('<h1>404</h1>');
      return;
    }
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': type,
      // A saved book is rewritten whenever the pipeline improves and
      // `npm run reparse` runs, so the browser must revalidate rather than
      // serve a parse from before the fix.
      'cache-control': inBooks ? 'no-cache' : 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': MIME['.html'] }).end('<h1>404</h1>');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/search') return await handleSearch(url, res);
    if (url.pathname === '/api/text') return await handleText(url, res);
    if (url.pathname === '/api/library') {
      if (req.method === 'POST') return await handleSave(req, res);
      return json(res, 200, await library.list());
    }
    if (url.pathname === '/api/sources') return await handleSources(res);
    if (url.pathname === '/api/renders') {
      const slug = url.searchParams.get('book');
      if (!slug) return json(res, 400, { error: 'missing ?book=' });
      return json(res, 200, await library.renders(slug));
    }
    await serveStatic(url.pathname, res, req);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Public Domain Reader\n`);
  console.log(`  Mac      http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  iPhone   http://${ip}:${PORT}`);
  console.log(`\n  Saved books land in ${library.LIBRARY_DIR}\n`);
});
