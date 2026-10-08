# Public Domain Reader

Find public domain books, read them well, and listen to them in a voice tuned
for comprehension at speed.

Three prongs, one repo:

| Prong | What it is | Lives in |
|---|---|---|
| 1. Discover | Search several public domain archives at once, preferring clean plain text | `app/discover`, `server/sources` |
| 2. Read | A focused ebook reader, Mac desktop and iPhone | `app/reader` |
| 3. Listen | Local neural TTS, deeply customizable, rendered offline to audio files | `app/speech`, `tts/` |

They share one spine: a pipeline that turns any archive's raw bytes into a
normalized book (strip boilerplate, detect chapters, split paragraphs and
sentences). The reader renders that model; the speech engine speaks it and
highlights against it. Splitting the prongs into separate repos would mean
maintaining that pipeline three times.

## Running it

```
npm run index     # once, and whenever you want a fresher catalog
npm start
```

One Node process serves the app *and* proxies the archives, so the browser is
always same-origin. It binds `0.0.0.0` and prints a LAN URL for the iPhone.

## Saving a book

Search, then press **Save**. The book is downloaded, parsed, and written to
`library/<author>-<title>-<source><id>/`:

    book.txt          the prose, with boilerplate and OCR debris stripped
    book.json         the parsed structure, including stable sentence ids
    meta.json         title, author, source, stats, and how chapters were detected
    corrections.json  only if you corrected the chapters; see below

Saving happens on the server because the server is the Mac. The point is real
files on disk that an offline TTS render -- or anything else -- can read, not
a copy trapped in browser storage.

## The local catalog

`npm run index` mirrors the Project Gutenberg catalog, turning search from a
network round trip into a memory scan: **7-80ms locally against 78,130 books**,
against seconds over the network, with a 26s worst case observed.

Only Gutenberg is mirrored, because only Gutenberg publishes something worth
mirroring:

| Source | Mirrored | Why |
|---|---|---|
| Project Gutenberg | yes | Full catalog CSV, refreshed daily: 21MB in, 78,130 books out |
| Wikisource | no | Publishes an all-titles dump, but with no author or subject metadata |
| Internet Archive | no | Tens of millions of items and no dump to mirror |

The CSV also carries Subjects and Bookshelves that the per-query API never
returns, which makes browsing by subject possible later.

Indexing then crawls the head of Gutendex's popularity ordering for download
counts, because the CSV has none -- and without a popularity signal, search
cannot tell *Alice's Adventures in Wonderland* from *Alice in Wonderland,
Retold in Words of One Syllable*. The retelling wins on text alone, since it
contains the query as a literal substring and the real book does not.

The UI shows each source's mode -- local or live -- and, after a search, how
many results it returned and how long it took. These archives are volunteer
run and erratic, so a slow search should be legible rather than a spinner that
might never end. Each source has its own deadline for the same reason: the
fan-out can otherwise only finish when its slowest member does.

### Ranking across sources

Scores from different archives are not comparable. Sorting by raw popularity
put the Internet Archive's most-downloaded loose matches -- console manuals,
newspapers -- above the actual book, because its download counts dwarf
Gutenberg's. What does compare is each result's rank *within its own source*,
weighted by how good that source's text tends to be. `tests/search.js` pins
the queries that have one obvious right answer.

## Why a server at all

The reader was meant to be static files on disk. Two findings made a small
local server the better answer:

- **Project Gutenberg sends no CORS header on its text files.** The catalog API
  (Gutendex) allows cross-origin requests, but the actual books do not, so no
  purely static page can download them. Verified, not assumed.
- **iOS Safari cannot run a multi-file app from the Files app** — `file://`
  blocks module loading, service workers and persistent storage.

Serving from the Mac solves both at once and costs one `npm start`.

### Consequences to remember

Because the LAN URL is plain `http://`, the iPhone is **not a secure context**:
no service workers (so no offline caching) and no `SharedArrayBuffer`. The Mac
must be awake and on the same Wi-Fi. This is fine, because heavy speech
synthesis happens on the Mac anyway — see below.

## Sources

Verified live, September 2026:

| Source | Catalog | Full text | Notes |
|---|---|---|---|
| Project Gutenberg (via Gutendex) | CORS `*` | **no CORS** | Best text: proofread, clean, ~75k books |
| Internet Archive | CORS `*` | CORS `*` | Vast, but OCR — much dirtier. Excludes `inlibrary` (lending) items |
| Wikisource | CORS `*` with `origin=*` | same API | Human-transcribed. Structure is awkward: works are split across subpages, behind disambiguation and "versions" pages |
| Standard Ebooks | **401** | — | OPDS feeds now gated; EPUB only, no plain text. Not integrated |

## Speech

Rendering happens **on the Mac, offline, ahead of time**, not live on the
phone. That choice buys a lot:

- No realtime budget, so we can run a far better model than a phone could.
- Exact pauses, because we synthesize sentence by sentence and stitch with
  precisely measured silence, rather than hoping an engine honors punctuation.
- A **free, exact sync map** — measuring each sentence clip gives perfect
  highlighting without depending on `onboundary` events, which are unreliable
  on iOS.
- Output is a plain audio file, so it plays anywhere offline.

Two outputs from one render:

1. `book.m4b` with chapter markers — drops into Apple Books and plays natively
   on the iPhone, offline, no app and no Mac required.
2. `book.m4a` + `book.sync.json` — our own player, with sentence highlighting
   and read-along.

### Engine

macOS `say` was evaluated and rejected: the built-in voices are dated
concatenative synths and no parameter tuning fixes the timbre.

The target is **Kokoro** (82M params, Apache-2.0), run locally through
`uv`-managed Python — no Homebrew, no system Python changes. On this M4 it
synthesizes several times faster than realtime. It earns the "highly
customizable" requirement because it exposes:

- ~50 voices, and **voice blending** — mix embedding vectors to build a voice
  that doesn't ship with the model
- speed control at synthesis time, independent of playback rate
- **phoneme-level pronunciation overrides**, which matter a great deal for
  archaic spellings, roman numerals and abbreviations

On top of the engine sits an engine-independent prosody layer we control
outright: inter-sentence, inter-paragraph and comma pause durations, rate
ramp-up at chapter starts, and a pronunciation rewrite dictionary.

## The text pipeline

`app/core/pipeline` turns raw archive bytes into the Book structure both other
prongs address. It is plain ES modules, so the same code runs in the browser
and in Node during an offline render.

    clean.js      strip each archive's boilerplate, license and OCR debris
    blocks.js     rejoin hard-wrapped lines into paragraphs, preserve verse
    chapters.js   find chapter divisions
    sentences.js  split into sentences
    index.js      compose into a Book, assign stable sentence ids

Sentences carry stable ids (`c5.b12.s2`) because the speech renderer keys its
sync map by them and the reader uses them as scroll anchors. They must not
shift between runs over the same text.

### Why it is built the way it is

Every step is a heuristic -- a plain text book has no markup to rely on -- so
each one is a response to something real in `tests/pipeline.js`:

- **Sentences.** `Intl.Segmenter` handles the easy cases but breaks on what
  19th-century prose is made of: courtesy titles, initials, and dialogue. It
  generates candidates and we merge its bad splits back. Breaking `"Stop!" he
  cried.` in two is not cosmetic -- it puts a pause in the middle of a spoken
  sentence.
- **Verse.** Line breaks are authorial in poetry and incidental in prose, so
  unwrapping everything would flatten poetry and unwrapping nothing would
  pause at every line end.
- **Chapters.** Detection does not try patterns in priority order and take the
  first that clears a threshold. It scores every candidate set, because the
  decisive signal is not which pattern matched but that real chapters carve a
  book into roughly even pieces.

### Known limits

Chapter detection is right on most books and close on the rest. It cannot be
perfect: an all-capitals line mid-story is structurally identical to a story
title. Current corpus results -- Frankenstein, Pride and Prejudice, Alice and
The Yellow Wallpaper exact; Moby-Dick finds 132 of 136; Sherlock Holmes finds
14 where 12 are wanted (it also catches the numbered sections inside *A
Scandal in Bohemia*); Dubliners finds 18 where 15 are wanted (it also catches
newspaper headlines quoted inside the stories).

### Correcting chapters

Since detection cannot be perfect, the reader can correct it. The **§** button
lists the chapters as detected, with their lengths -- a false one usually
stands out as a sliver -- and each can be struck out with *Not a chapter*,
which folds it into the chapter before it. Its heading stays in the text, because it was text all along: a headline
the character is reading, a numbered section inside a story. *Mark missed
chapters* does the opposite: tap a line in the text and it becomes a chapter
title. Detection can also be forced to one pattern, or to none.

Corrections live in `corrections.json`, and the server applies them inside the
pipeline and rewrites `book.json`, so the reader and the speech renderer see
one structure. They name a line by its opening words and which occurrence of
those words it is, not by position, so they survive `npm run reparse` and
improvements to cleaning. One that stops matching any line is reported, not
silently dropped. With them, all three books above come out right.

**Correct a book before rendering it.** Sentence ids carry the chapter number,
so a correction renumbers every chapter after it. Each chapter in `book.json`
carries a fingerprint of exactly what the renderer reads, every render records
the fingerprint it was made from, and a chapter whose fingerprint has changed
reads as stale: the reader will not play it against text it no longer
matches, and `render.py --list` shows it as changed. Undoing the correction
makes the same audio current again -- nothing is deleted.

## Listening while reading

Render a book (see `tts/README.md`), open it in the reader, and the transport
appears above the text. The spoken sentence is highlighted as it is read, and
tapping any sentence jumps the voice there.

Highlighting is a lookup, not an estimate. The audio was synthesized one
sentence at a time and every clip measured, so `sync.json` holds exact start
and end times keyed by the same sentence ids the reader renders as spans --
no dependence on `onboundary` events, which are unreliable on iOS and absent
for pre-rendered audio anyway.

Two speed multipliers stack: the one baked in at synthesis, and the playback
rate on top. The transport shows their product, which is the only figure a
listener cares about.

## Using the archives responsibly

Every archive here is volunteer-run and free. This tool identifies itself on
each request, and you should make that identification point at you:

```
export PDR_CONTACT="https://github.com/you/your-fork"   # or an email
```

Wikimedia's User-Agent policy requires a descriptive agent with a means of
contact and permits refusing requests without one. The others do not demand
it, but an unidentified client is an unaccountable one -- if this tool
misbehaves, someone should be able to tell you rather than simply block it.

`npm run index` deliberately fetches at two concurrent requests with backoff
and spacing. That is not a placeholder to tune up: six concurrent requests
lost 58 of 100 pages to rate limiting, and the polite version lost none.
Project Gutenberg also asks that bulk users work from its mirrors rather than
the main site.

This project is not affiliated with Project Gutenberg, the Internet Archive or
Wikisource. It strips Project Gutenberg's header and license from the text it
speaks, because a synthesizer reading a licence aloud helps nobody; the
underlying works are in the public domain, and the archives are named only to
say where a book came from.

## License

MIT -- see [LICENSE](LICENSE). This covers the code in this repository only.
The books are public domain, and the speech model carries its own licence
(Kokoro is Apache-2.0).

The repository distributes only its own source. Everything else is fetched by
whoever runs it -- Node itself, and the Python packages `uv` installs into
`tts/.venv` -- under that project's own licence:

| Dependency | Licence | Why it is here |
|---|---|---|
| Node.js | MIT | the server and pipeline; no npm packages |
| Kokoro model and voices | Apache-2.0 | the voice |
| kokoro-onnx | MIT | runs the model |
| onnxruntime | MIT | via kokoro-onnx |
| phonemizer | GPL-3.0-or-later | via kokoro-onnx: text to phonemes |
| espeak-ng, inside espeakng-loader | GPL-3.0-or-later | via kokoro-onnx: phoneme rules |
| soundfile | BSD-3-Clause | writes audio files |
| libsndfile, inside soundfile's wheels | LGPL-2.1 | the codecs soundfile uses |
| numpy | BSD-3-Clause | audio buffers |

The speech side therefore runs GPL-3 code. That is no constraint on this
repository, which contains none of it, but a packaged build that bundled the
Python environment -- an installer, an app -- would carry those terms, so check
before distributing one.

Audio encoders are deliberately not bundled either. `afconvert` ships with
macOS; nothing here downloads or includes an encoder of its own.

## Tests

    node tests/pipeline.js       structure, against a corpus of awkward books
    node tests/corrections.js    chapter corrections, on the books detection gets wrong
    node tests/search.js         ranking regressions

## Status

All three prongs work end to end:

- **Discover** -- search three archives at once, rank across them, save to
  disk. Gutenberg answers from a local mirror.
- **Read** -- one chapter at a time, typography settings, and the place you
  left off, on the Mac or on the iPhone over Wi-Fi.
- **Listen** -- offline Kokoro renders, one audio file per chapter, played
  back in the reader with the spoken sentence highlighted.

Not built yet:

- The single `book.m4b` with chapter markers described under *Speech*.
  Renders are one `.m4a` per chapter, which only the reader plays.
- Starting a render from the app. It is `tts/render.py` on the command line.
- Roman numerals and phoneme-level overrides. Profiles rewrite abbreviations
  as text, and nothing yet decides how `Chapter XIV` or `Henry VIII` is said.
