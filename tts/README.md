# Offline speech rendering

Renders a saved book to audio on the Mac, ahead of time, rather than speaking
it live on the phone.

## Setup

Needs [uv](https://docs.astral.sh/uv/). Nothing here touches the system Python
or requires Homebrew. Written to run on Linux and Windows as well as macOS,
but so far only run on macOS.

```
cd tts
uv venv --python 3.12
uv pip install -r pyproject.toml
mkdir -p models && cd models
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

That is a 354MB download. Both files are gitignored.

## Rendering

```
.venv/bin/python render.py --book <slug> --list           # cost first, renders nothing
.venv/bin/python render.py --book <slug> --preview        # a few sentences, to tune
.venv/bin/python render.py --book <slug> --chapters 1-3
.venv/bin/python render.py --book <slug>                  # the whole book
```

Run `--list` first. A book is hours of compute, and scholarly editions hide
surprises -- the Jowett *Republic* opens with a 5.5 hour introduction that is
the translator's essay rather than Plato, which is 43% of the whole render.

Indexes, footnotes and printer colophons are skipped by default: an index is
thousands of fragments and hours of synthesis producing something nobody
would listen to. `--include-reference` overrides that, and a profile can set
its own `skipTitles`.

A fragment that cannot be synthesized is skipped and reported at the end
rather than ending the run. This is not hypothetical: a stray `_]` left by a
footnote in the *Republic*'s index has no phonemes, and it killed a render
two and a half hours in.

Output lands in `library/<slug>/audio/<profile>/`: one file per chapter, plus
`sync.json`.

Chapters are compressed with whatever encoder the machine already has: AAC
through `afconvert` on macOS, otherwise MP3 through the libsndfile bundled in
soundfile's wheels on Windows, macOS and Linux. Both run at 64 kbps; the MP3 is
constant-rate, so seeking to a tapped sentence lands where the sync map says,
and carries the header that records the encoder's delay, so its timings match
the WAV's exactly. `--wav` keeps the uncompressed file instead.

`sync.json` records each chapter's fingerprint from `book.json`. If the
chapters are corrected in the reader afterwards, every chapter from the
correction onwards is renumbered, and its audio reads as stale rather than
playing against the wrong sentences. `--list` marks each chapter `rendered`
or `changed since rendered`, and counts only what is left in its total.

## Choosing a voice

```
.venv/bin/python compare.py --voices af_heart,bf_emma,am_michael --speeds 1.0,1.5
.venv/bin/python compare.py --voices "af_heart:0.6+am_michael:0.4"   # a blend
.venv/bin/python compare.py --book <slug> --chapter 3                # real prose
```

Every variant is announced and concatenated into one file, so comparing means
playing one track. Judge at the speed you actually intend to listen at: voices
that are pleasant at 1.0 often fall apart at 1.5, which is where comprehension
is won or lost.

## Why render offline

macOS `say` was tried first and rejected -- its voices are dated concatenative
synths and no amount of parameter tuning fixes the timbre. Kokoro (82M params,
Apache-2.0) runs locally and sounds like a person.

Rendering ahead of time rather than speaking live buys four things:

- **No realtime budget**, so the model can be better than a phone could run.
- **Exact pauses.** Synthesis happens one sentence at a time and the clips are
  stitched with measured silence, rather than hoping the engine honours
  punctuation. That is precisely what fails at speed, when a voice runs
  sentences together and comprehension goes with it. The gap after a sentence,
  after a paragraph, and between verse lines are separately adjustable.
- **A sync map for free.** Measuring each clip gives exact sentence timings
  keyed by the pipeline's sentence ids, so highlighting never depends on
  `onboundary` events, which are unreliable on iOS.
- **Plain audio files**, which play anywhere, offline, with no Mac running.

## Profiles

`profiles/<name>.json` holds the settings: voice (a name or a blend), speed,
the three pause durations, chapter ramp-up, and a pronunciation table applied
before synthesis for the abbreviations a modern voice mangles.

Blending is why this model was chosen. The style vectors are plain arrays, so
mixing them produces a speaker that ships with neither -- which is what
"dial in a voice" actually requires.

```json
"voice": { "af_heart": 0.65, "am_michael": 0.35 }
```

## Performance

Measured on an M4, single-threaded CPU:

| | |
|---|---|
| Throughput | ~3x realtime |
| A 75,000-word novel | ~7.8h of audio, ~2.6h to render |
| Model load | ~1.3s |

**CoreML is slower than CPU here** -- 2.5x against 3.0x on the same passage --
so `render.py` pins `CPUExecutionProvider` deliberately. It is not an
oversight to be optimised away later.
