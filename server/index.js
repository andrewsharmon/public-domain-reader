// The one process behind the whole project.
//
// It serves the app AND proxies the book archives, which means the browser is
// always same-origin and the CORS problem simply doesn't arise -- Project
// Gutenberg sends no CORS header on its text files, so a purely static build
// could never download them.
//
// It binds 0.0.0.0 so an iPhone on the same Wi-Fi can read from the Mac.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

import * as cache from './cache.js';
import * as gutenberg from './sources/gutenberg.js';
import * as archive from './sources/archive.js';
import * as wikisource from './sources/wikisource.js';

const SOURCES = { gutenberg, archive, wikisource };
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
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': MIME['.json'] });
  res.end(JSON.stringify(body));
};

// Fan out across every requested source at once. One archive being down or
// slow must never take out the whole search, so failures come back as data
// alongside the results rather than as a rejected request.
async function handleSearch(url, res) {
  const query = url.searchParams.get('q')?.trim();
  if (!query) return json(res, 400, { error: 'missing ?q=' });

  const names = (url.searchParams.get('sources') ?? Object.keys(SOURCES).join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s in SOURCES);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50);

  const settled = await Promise.allSettled(
    names.map((n) => SOURCES[n].search(query, { limit })),
  );

  const results = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') results.push(...r.value);
    else errors.push({ source: names[i], message: r.reason?.message ?? String(r.reason) });
  });

  results.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  json(res, 200, { query, count: results.length, results, errors });
}

async function handleText(url, res) {
  const source = url.searchParams.get('source');
  const sourceId = url.searchParams.get('id');
  if (!source || !sourceId) return json(res, 400, { error: 'missing ?source= and ?id=' });
  if (!(source in SOURCES)) return json(res, 404, { error: `unknown source: ${source}` });

  const hit = await cache.read(source, sourceId);
  if (hit) return json(res, 200, { ...hit, cached: true });

  try {
    const payload = await SOURCES[source].fetchText(sourceId);
    await cache.write(source, sourceId, payload);
    json(res, 200, { ...payload, cached: false });
  } catch (err) {
    // Wikisource navigation pages aren't a failure so much as a question:
    // which edition did you mean? Pass the options through.
    if (err.code === 'AMBIGUOUS') {
      return json(res, 409, { error: err.message, code: err.code, choices: err.choices });
    }
    json(res, 502, { error: err.message });
  }
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(APP_DIR, rel);

  // Never let a crafted path escape the app directory.
  if (!file.startsWith(APP_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
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
    if (url.pathname === '/api/sources') {
      return json(res, 200, Object.values(SOURCES).map((s) => ({ id: s.id, label: s.label })));
    }
    await serveStatic(url.pathname, res);
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
  console.log('');
});
