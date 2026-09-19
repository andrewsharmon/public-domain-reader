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
npm start
```

One Node process serves the app *and* proxies the archives, so the browser is
always same-origin. It binds `0.0.0.0` and prints a LAN URL for the iPhone.

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

## Status

Scaffold. Search fans out across all three archives and returns normalized
results; the reader and speech engine are not built yet.
