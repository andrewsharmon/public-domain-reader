// Wikisource. Human-transcribed and proofread, so the text quality rivals
// Gutenberg, and it covers shorter works, essays and documents the others miss.
//
// The awkward part is structure: long works are split across subpages under an
// index page (`Walden/Chapter 1`, ...), so fetching a title can yield a table
// of contents instead of prose. `fetchText` follows those links one level deep.

const API = 'https://en.wikisource.org/w/api.php';

export const id = 'wikisource';
export const label = 'Wikisource';

function toBook(raw) {
  return {
    id: `wikisource:${raw.title}`,
    source: id,
    sourceId: raw.title,
    title: raw.title,
    authors: [],
    year: null,
    languages: ['en'],
    subjects: [],
    cover: null,
    popularity: 0,
    hasPlainText: true,
    sourceUrl: `https://en.wikisource.org/wiki/${encodeURIComponent(raw.title)}`,
  };
}

async function api(params, signal) {
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const res = await fetch(`${API}?${qs}`, { signal });
  if (!res.ok) throw new Error(`wikisource api failed: ${res.status}`);
  return res.json();
}

export async function search(query, { limit = 20, signal } = {}) {
  // ns0 keeps results in the main namespace, out of Author:/Page:/Index: space.
  const data = await api(
    { action: 'query', list: 'search', srsearch: query, srlimit: String(limit), srnamespace: '0' },
    signal,
  );
  return (data.query?.search ?? []).map(toBook);
}

async function parsedText(title, signal) {
  const data = await api({ action: 'parse', page: title, prop: 'text' }, signal);
  return data.parse?.text ?? '';
}

// Subpage links are how Wikisource models chapters; anything under `Title/` is
// part of the same work and should be read in document order.
function subpageLinks(html, title) {
  const prefix = `/wiki/${title.replace(/ /g, '_')}/`;
  const found = [];
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = decodeURIComponent(m[1]);
    if (!href.startsWith(prefix)) continue;
    const sub = href.slice('/wiki/'.length).replace(/_/g, ' ').split('#')[0];
    if (!found.includes(sub)) found.push(sub);
  }
  return found;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<table[\s\S]*?<\/table>/gi, '')
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Wikisource routes a title through up to three navigation layers before the
// prose: a disambiguation page, then a "versions" page listing editions, then
// the edition itself. Those pages are not subpages of each other, so they
// can't be crawled the way chapters can -- and returning their text as if it
// were the book would be quietly wrong. Detect them and report the choices so
// the caller can ask which edition is wanted.
function navigationChoices(html) {
  const isNav = /wikitable|disambiguation|versions-page|ws-noexport/.test(html)
    && /This is a disambiguation page|Versions of|Works entitled/i.test(stripHtml(html));
  if (!isNav) return null;

  const seen = new Set();
  for (const m of html.matchAll(/href="\/wiki\/([^"#?]+)"/g)) {
    const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
    // Skip cross-namespace links (Author:, Wikipedia:, Category:, ...).
    if (title.includes(':')) continue;
    seen.add(title);
  }
  return seen.size ? [...seen] : null;
}

export async function fetchText(sourceId, { signal, maxSubpages = 60 } = {}) {
  const html = await parsedText(sourceId, signal);

  const choices = navigationChoices(html);
  if (choices) {
    const err = new Error(`wikisource:${sourceId} is a navigation page, not a work`);
    err.code = 'AMBIGUOUS';
    err.choices = choices;
    throw err;
  }

  const subs = subpageLinks(html, sourceId);

  let text = stripHtml(html);

  // A short page with subpage links is an index, not the work itself.
  if (subs.length > 0 && text.length < 20000) {
    const parts = [];
    for (const sub of subs.slice(0, maxSubpages)) {
      try {
        parts.push(`\n\n${sub.split('/').pop()}\n\n${stripHtml(await parsedText(sub, signal))}`);
      } catch {
        // A missing chapter shouldn't sink the whole book.
      }
    }
    if (parts.length) text = parts.join('\n\n');
  }

  return {
    text,
    textUrl: `https://en.wikisource.org/wiki/${encodeURIComponent(sourceId)}`,
    book: toBook({ title: sourceId }),
  };
}
