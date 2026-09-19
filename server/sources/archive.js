// Internet Archive. Huge scanned-text collection; the full text is OCR, so it
// is noticeably dirtier than Gutenberg's proofread transcriptions. Good for
// long-tail titles Gutenberg never digitized.
//
// Both the search and the download endpoints send CORS `*`, so this adapter
// would work client-side too -- it runs here only for consistency and caching.

const SEARCH = 'https://archive.org/advancedsearch.php';
const META = 'https://archive.org/metadata';
const DOWNLOAD = 'https://archive.org/download';

export const id = 'archive';
export const label = 'Internet Archive';

// `inlibrary` marks controlled-digital-lending items, which are in copyright
// and only borrowable -- excluding it keeps results to freely readable scans.
function buildQuery(query) {
  return `(${query}) AND mediatype:texts AND NOT collection:inlibrary`;
}

function toBook(doc) {
  const creator = Array.isArray(doc.creator) ? doc.creator : doc.creator ? [doc.creator] : [];
  return {
    id: `archive:${doc.identifier}`,
    source: id,
    sourceId: doc.identifier,
    title: doc.title ?? doc.identifier,
    authors: creator,
    year: doc.year ? Number(doc.year) : null,
    languages: [].concat(doc.language ?? []),
    subjects: [].concat(doc.subject ?? []).slice(0, 6),
    cover: `https://archive.org/services/img/${doc.identifier}`,
    popularity: doc.downloads ?? 0,
    // Only the metadata call can confirm a text file exists; assume yes and
    // let fetchText report the truth rather than pay an extra request per hit.
    hasPlainText: true,
    sourceUrl: `https://archive.org/details/${doc.identifier}`,
  };
}

export async function search(query, { limit = 20, signal } = {}) {
  const params = new URLSearchParams({
    q: buildQuery(query),
    output: 'json',
    rows: String(limit),
    page: '1',
  });
  for (const f of ['identifier', 'title', 'creator', 'year', 'language', 'subject', 'downloads']) {
    params.append('fl[]', f);
  }
  params.append('sort[]', 'downloads desc');

  const res = await fetch(`${SEARCH}?${params}`, { signal });
  if (!res.ok) throw new Error(`archive search failed: ${res.status}`);
  const data = await res.json();
  return (data.response?.docs ?? []).map(toBook);
}

// Prefer a hand-made plain text file over the OCR dump when the item has one.
function pickTextFile(files = []) {
  return (
    files.find((f) => f.format === 'Text' && f.name.endsWith('.txt')) ??
    files.find((f) => f.name.endsWith('_djvu.txt')) ??
    files.find((f) => f.name.endsWith('.txt')) ??
    null
  );
}

export async function fetchText(sourceId, { signal } = {}) {
  const metaRes = await fetch(`${META}/${encodeURIComponent(sourceId)}`, { signal });
  if (!metaRes.ok) throw new Error(`archive lookup failed: ${metaRes.status}`);
  const meta = await metaRes.json();

  const file = pickTextFile(meta.files);
  if (!file) throw new Error(`no plain text available for archive:${sourceId}`);

  const url = `${DOWNLOAD}/${encodeURIComponent(sourceId)}/${encodeURIComponent(file.name)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`archive download failed: ${res.status}`);

  const m = meta.metadata ?? {};
  return {
    text: await res.text(),
    textUrl: url,
    book: toBook({ ...m, identifier: sourceId, downloads: 0 }),
  };
}
