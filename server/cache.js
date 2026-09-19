// Disk cache for fetched book text. Downloads are large, slow, and immutable
// once published, so there's no reason to ever pull the same book twice --
// and it keeps us from hammering the upstream archives during development.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIR = path.join(process.cwd(), '.cache', 'text');

const keyFor = (source, sourceId) =>
  createHash('sha1').update(`${source}:${sourceId}`).digest('hex').slice(0, 16);

export async function read(source, sourceId) {
  try {
    return JSON.parse(await readFile(path.join(DIR, `${keyFor(source, sourceId)}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function write(source, sourceId, payload) {
  await mkdir(DIR, { recursive: true });
  await writeFile(
    path.join(DIR, `${keyFor(source, sourceId)}.json`),
    JSON.stringify({ ...payload, cachedAt: new Date().toISOString() }),
    'utf8',
  );
}
