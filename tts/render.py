#!/usr/bin/env python
"""Offline neural speech rendering.

Renders a saved book to audio on the Mac, ahead of time, rather than speaking
it live on the phone. That choice is what makes the rest possible:

  - No realtime budget, so the model can be far better than a phone could run.
  - Exact pauses. Synthesis happens one sentence at a time and the clips are
    stitched with measured silence, instead of hoping an engine honours
    punctuation -- which is precisely what breaks down at speed, when a voice
    runs sentences together and comprehension goes with it.
  - A sync map for free. Measuring each clip gives exact sentence timings,
    so highlighting never depends on `onboundary` events, which are
    unreliable on iOS.
  - Plain audio files, which play anywhere, offline.

Usage:
    python render.py --book <slug>                  # whole book
    python render.py --book <slug> --chapters 1-3   # a range
    python render.py --book <slug> --preview        # a few sentences, to tune
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent
LIBRARY = ROOT.parent / "library"
MODEL = ROOT / "models" / "kokoro-v1.0.onnx"
VOICES = ROOT / "models" / "voices-v1.0.bin"

# Kokoro's style vectors are indexed by token count and cap out at 510, so a
# very long sentence has to be broken before synthesis. Splitting on clause
# boundaries keeps the seam somewhere the ear already expects a pause.
MAX_CHARS = 400

# Kokoro's `speed` parameter is neither linear nor unbounded. It refuses
# anything above 2.0, and well before that it delivers less than it promises.
# Measured on this model, af_heart, same passage:
#
#     requested   1.00  1.25  1.50  1.75  2.00
#     actual      1.00  1.14  1.52  1.63  1.76
#
# So a book rendered at "2.0" really reads at about 1.76x. The player closes
# the gap with playbackRate, which is why the manifest records what the
# synthesis actually achieved rather than what was asked for.
SPEED_CURVE = {1.0: 1.00, 1.25: 1.14, 1.5: 1.52, 1.75: 1.63, 2.0: 1.76}


def effective_speed(requested: float) -> float:
    """What `requested` actually delivers, interpolating between measurements."""
    points = sorted(SPEED_CURVE.items())
    if requested <= points[0][0]:
        return points[0][1]
    if requested >= points[-1][0]:
        return points[-1][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= requested <= x1:
            return y0 + (y1 - y0) * (requested - x0) / (x1 - x0)
    return requested


def load_profile(name: str) -> dict:
    path = ROOT / "profiles" / f"{name}.json"
    if not path.exists():
        sys.exit(f"No such profile: {path}")
    profile = json.loads(path.read_text())
    # Keys beginning with an underscore are documentation for whoever edits
    # the profile by hand, not settings.
    return {k: v for k, v in profile.items() if not k.startswith("_")}


def build_kokoro():
    import onnxruntime as ort
    from kokoro_onnx import Kokoro

    if not MODEL.exists():
        sys.exit(f"Model missing: {MODEL}\nSee tts/README.md for the download.")

    # Measured on an M4: CoreML runs this model at 2.5x realtime against 3.0x
    # on CPU, so the accelerator is a pessimisation here. Left explicit so it
    # is not "optimised" back later.
    options = ort.SessionOptions()
    options.log_severity_level = 3
    session = ort.InferenceSession(
        str(MODEL), sess_options=options, providers=["CPUExecutionProvider"]
    )
    return Kokoro.from_session(session, str(VOICES))


def resolve_voice(kokoro, voice):
    """A voice name, or a blend: {"af_heart": 0.65, "am_michael": 0.35}.

    Blending is the reason this model was chosen. The style vectors are plain
    arrays, so mixing them produces a speaker that ships with neither -- which
    is what "dial in a voice" actually requires.
    """
    if isinstance(voice, str):
        return voice, voice

    total = sum(voice.values())
    if total <= 0:
        sys.exit("Voice blend weights must sum to more than zero.")

    mixed = None
    for name, weight in voice.items():
        style = kokoro.get_voice_style(name) * (weight / total)
        mixed = style if mixed is None else mixed + style

    label = " + ".join(f"{n}:{w / total:.2f}" for n, w in voice.items())
    return mixed, label


def make_pronouncer(rules: dict):
    """Text rewrites applied before synthesis.

    Archaic spellings, contractions and abbreviations that a modern voice
    mangles -- `&c.` read as "and see", `St.` as "street" when it means saint.
    """
    compiled = [(re.compile(pattern), repl) for pattern, repl in rules.items()]

    def apply(text: str) -> str:
        for pattern, repl in compiled:
            text = pattern.sub(repl, text)
        return text

    return apply


def split_long(text: str) -> list[str]:
    """Break an over-long sentence at clause boundaries."""
    if len(text) <= MAX_CHARS:
        return [text]

    parts, current = [], ""
    for clause in re.split(r"(?<=[;:,])\s+", text):
        if current and len(current) + len(clause) + 1 > MAX_CHARS:
            parts.append(current)
            current = clause
        else:
            current = f"{current} {clause}".strip()
    if current:
        parts.append(current)
    return parts


def iter_units(chapter: dict, skip_front_matter: bool):
    """Yield (sentence_id, text, kind) for one chapter.

    `kind` decides which pause follows: the gap after a sentence, after a
    paragraph, and between verse lines are all different, and getting those
    three durations right is most of what makes fast speech followable.
    """
    if skip_front_matter and chapter.get("frontMatter"):
        return

    blocks = chapter.get("blocks", [])
    for b, block in enumerate(blocks):
        verse = block.get("type") == "verse"
        sentences = block.get("sentences", [])
        for s, sentence in enumerate(sentences):
            last_in_block = s == len(sentences) - 1
            if verse:
                kind = "paragraph" if last_in_block else "verseLine"
            else:
                kind = "paragraph" if last_in_block else "sentence"
            yield sentence["id"], sentence["text"], kind


def render_chapter(kokoro, chapter, profile, voice, pronounce, sample_rate=24000):
    """Synthesize one chapter, returning audio and exact sentence timings."""
    pauses = profile.get("pauses", {})
    ramp = profile.get("rampUp", {})
    base_speed = float(profile.get("speed", 1.0))
    lang = profile.get("lang", "en-us")

    pieces: list[np.ndarray] = []
    timings: list[dict] = []
    position = 0.0  # seconds of audio emitted so far

    units = list(iter_units(chapter, profile.get("skipFrontMatter", True)))

    for index, (sid, text, kind) in enumerate(units):
        spoken = pronounce(text)

        # Comprehension suffers most in the first few sentences of a chapter,
        # before you have the voice and the context, so ease into the target
        # speed rather than starting at it.
        speed = base_speed
        if ramp.get("enabled") and index < ramp.get("sentences", 0):
            start = float(ramp.get("startSpeed", 0.9))
            progress = index / max(ramp.get("sentences", 1), 1)
            speed = base_speed * (start + (1 - start) * progress)

        start_time = position
        for part in split_long(spoken):
            samples, sample_rate = kokoro.create(
                part, voice=voice, speed=speed, lang=lang
            )
            pieces.append(samples)
            position += len(samples) / sample_rate

        # The sentence's own span excludes the silence that follows it, so
        # highlighting clears as the voice stops rather than lingering.
        timings.append({"id": sid, "start": round(start_time, 3), "end": round(position, 3)})

        gap = float(pauses.get(kind, 0.0))
        if gap > 0:
            pieces.append(np.zeros(int(gap * sample_rate), dtype=np.float32))
            position += gap

    if not pieces:
        return None, [], 0.0

    return np.concatenate(pieces), timings, position


def to_m4a(wav: Path) -> Path | None:
    """Compress with afconvert, which ships with macOS -- no ffmpeg needed."""
    m4a = wav.with_suffix(".m4a")
    try:
        subprocess.run(
            ["afconvert", "-f", "m4af", "-d", "aac", "-b", "64000", str(wav), str(m4a)],
            check=True, capture_output=True,
        )
        wav.unlink()
        return m4a
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None  # keep the wav


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--book", required=True, help="library slug")
    parser.add_argument("--profile", default="default")
    parser.add_argument("--chapters", help="e.g. 3 or 1-5; default is all")
    parser.add_argument("--voice", help="override the profile's voice")
    parser.add_argument("--speed", type=float, help="override the profile's speed")
    parser.add_argument("--preview", action="store_true", help="first 6 sentences of one chapter, for tuning")
    parser.add_argument("--wav", action="store_true", help="keep lossless wav instead of m4a")
    args = parser.parse_args()

    book_dir = LIBRARY / args.book
    book_path = book_dir / "book.json"
    if not book_path.exists():
        sys.exit(f"Not in the library: {book_path}")
    book = json.loads(book_path.read_text())

    profile = load_profile(args.profile)
    if args.voice:
        profile["voice"] = args.voice
    if args.speed:
        profile["speed"] = args.speed

    chapters = book["chapters"]
    if args.chapters:
        lo, _, hi = args.chapters.partition("-")
        lo = int(lo)
        hi = int(hi) if hi else lo
        chapters = [c for c in chapters if lo <= c["index"] <= hi]
    if args.preview:
        chapters = [c for c in chapters if not c.get("frontMatter")][:1]
        if chapters:
            chapters = [dict(chapters[0])]
            trimmed, budget = [], 6
            for block in chapters[0]["blocks"]:
                if budget <= 0:
                    break
                take = block["sentences"][:budget]
                budget -= len(take)
                trimmed.append({**block, "sentences": take})
            chapters[0]["blocks"] = trimmed

    if not chapters:
        sys.exit("No chapters selected.")

    print(f"Loading Kokoro …")
    kokoro = build_kokoro()
    voice, voice_label = resolve_voice(kokoro, profile.get("voice", "af_heart"))
    pronounce = make_pronouncer(profile.get("pronunciations", {}))

    out_dir = book_dir / "audio" / (f"{args.profile}-preview" if args.preview else args.profile)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"{book.get('title', args.book)}")
    actual = effective_speed(float(profile.get("speed", 1.0)))
    print(f"  voice {voice_label} · speed {profile.get('speed', 1.0)} "
          f"(~{actual:.2f}x actual) · profile {args.profile}")
    print(f"  {len(chapters)} chapter(s) → {out_dir}\n")

    requested_speed = float(profile.get("speed", 1.0))
    manifest = {
        "profile": args.profile,
        "voice": voice_label,
        "speed": requested_speed,
        # What the synthesis actually delivers, so the player can make up the
        # difference with playbackRate instead of guessing.
        "effectiveSpeed": round(effective_speed(requested_speed), 3),
        "pauses": profile.get("pauses", {}),
        "sampleRate": 24000,
        "renderedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "chapters": [],
    }

    grand_audio = grand_time = 0.0

    for chapter in chapters:
        label = (chapter.get("title") or f"Chapter {chapter['index']}")[:44]
        print(f"  {label:46}", end="", flush=True)

        started = time.time()
        audio, timings, duration = render_chapter(kokoro, chapter, profile, voice, pronounce)
        elapsed = time.time() - started

        if audio is None:
            print("skipped")
            continue

        wav = out_dir / f"chapter-{chapter['index']:03d}.wav"
        sf.write(wav, audio, manifest["sampleRate"])
        final = (None if args.wav else to_m4a(wav)) or wav

        grand_audio += duration
        grand_time += elapsed
        print(f"{duration / 60:6.1f} min  in {elapsed / 60:5.1f} min  ({duration / elapsed:.1f}x)")

        manifest["chapters"].append({
            "index": chapter["index"],
            "title": chapter.get("title"),
            "file": final.name,
            "duration": round(duration, 2),
            "sentences": timings,
        })

    (out_dir / "sync.json").write_text(json.dumps(manifest, indent=2))

    print(f"\n  {grand_audio / 60:.1f} min of audio in {grand_time / 60:.1f} min "
          f"({grand_audio / max(grand_time, 0.001):.1f}x realtime)")
    print(f"  {out_dir}/sync.json")


if __name__ == "__main__":
    main()
