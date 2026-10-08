#!/usr/bin/env python
"""Render the same passage many ways, so you can hear the difference.

Dialling in a voice is a listening problem, not a settings problem. Reading
that `af_heart` is "warm" tells you nothing; hearing it against `bf_emma` on
the same sentence, at the speed you actually read at, tells you everything.

Every variant is announced and concatenated into one file, so comparing means
playing one track rather than juggling twenty. Judge at the speed you intend
to listen at -- voices that are pleasant at 1.0 often fall apart at 1.5, which
is exactly where comprehension is won or lost.

Usage:
    python compare.py --voices af_heart,bf_emma,am_michael
    python compare.py --voices af_heart --speeds 1.0,1.3,1.6
    python compare.py --book <slug> --chapter 1     # use real prose
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from render import (
    LIBRARY, build_kokoro, compress, make_pronouncer, load_profile, resolve_voice,
)

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "comparisons"

# Deliberately awkward: dialogue, a semicolon, a long clause and a question.
# A voice that handles this handles most prose.
DEFAULT_PASSAGE = (
    "There was nothing so very remarkable in that; nor did Alice think it so very "
    "much out of the way to hear the Rabbit say to itself, \"Oh dear! Oh dear! I "
    "shall be late!\" But when the Rabbit actually took a watch out of its "
    "waistcoat-pocket, she started to her feet. Was it really so strange?"
)


def passage_from_book(slug: str, chapter_index: int, sentences: int) -> str:
    path = LIBRARY / slug / "book.json"
    if not path.exists():
        sys.exit(f"Not in the library: {path}")
    book = json.loads(path.read_text())

    chapters = [c for c in book["chapters"] if not c.get("frontMatter")]
    chapter = next((c for c in chapters if c["index"] == chapter_index), chapters[0] if chapters else None)
    if chapter is None:
        sys.exit("That book has no readable chapters.")

    picked = []
    for block in chapter["blocks"]:
        for sentence in block["sentences"]:
            picked.append(sentence["text"])
            if len(picked) >= sentences:
                return " ".join(picked)
    return " ".join(picked)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voices", default="af_heart,af_bella,bf_emma,am_michael,am_puck",
                        help="comma-separated voice names, or name:weight+name:weight for a blend")
    parser.add_argument("--speeds", default="1.0", help="comma-separated speeds")
    parser.add_argument("--profile", default="default")
    parser.add_argument("--book", help="take the passage from a saved book instead of the default")
    parser.add_argument("--chapter", type=int, default=1)
    parser.add_argument("--sentences", type=int, default=4)
    parser.add_argument("--no-labels", action="store_true", help="omit the spoken announcements")
    args = parser.parse_args()

    passage = passage_from_book(args.book, args.chapter, args.sentences) if args.book else DEFAULT_PASSAGE
    profile = load_profile(args.profile)
    pronounce = make_pronouncer(profile.get("pronunciations", {}))

    voices = [v.strip() for v in args.voices.split(",") if v.strip()]
    speeds = [float(s) for s in args.speeds.split(",") if s.strip()]

    print("Loading Kokoro …")
    kokoro = build_kokoro()

    OUT.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = OUT / stamp
    out_dir.mkdir()

    sample_rate = 24000
    pieces: list[np.ndarray] = []
    index: list[dict] = []
    position = 0.0

    print(f"\npassage: {passage[:72]}…\n")

    for name in voices:
        # `af_heart:0.6+am_michael:0.4` describes a blend.
        if ":" in name:
            spec = {}
            for part in name.split("+"):
                voice_name, _, weight = part.partition(":")
                spec[voice_name.strip()] = float(weight or 1)
            voice, label = resolve_voice(kokoro, spec)
        else:
            voice, label = resolve_voice(kokoro, name)

        for speed in speeds:
            print(f"  {label:34} {speed:>4}x  ", end="", flush=True)
            start = position

            if not args.no_labels:
                spoken_label = f"{label.replace('_', ' ').replace(':', ' at ')}, speed {speed}"
                tag, sample_rate = kokoro.create(spoken_label, voice=voice, speed=1.0, lang="en-us")
                pieces.append(tag)
                pieces.append(np.zeros(int(0.5 * sample_rate), dtype=np.float32))
                position += len(tag) / sample_rate + 0.5

            began = time.time()
            audio, sample_rate = kokoro.create(pronounce(passage), voice=voice, speed=speed, lang="en-us")
            pieces.append(audio)
            pieces.append(np.zeros(int(1.0 * sample_rate), dtype=np.float32))

            duration = len(audio) / sample_rate
            position += duration + 1.0
            print(f"{duration:5.1f}s audio in {time.time() - began:4.1f}s")

            index.append({
                "voice": label, "speed": speed,
                "start": round(start, 2), "duration": round(duration, 2),
            })

    combined = out_dir / "comparison.wav"
    sf.write(combined, np.concatenate(pieces), sample_rate)
    final = compress(combined)

    (out_dir / "index.json").write_text(json.dumps({
        "passage": passage, "profile": args.profile, "variants": index,
    }, indent=2))

    print(f"\n  {position / 60:.1f} min → {final}")
    for entry in index:
        minutes, seconds = divmod(entry["start"], 60)
        print(f"    {int(minutes):d}:{seconds:05.2f}  {entry['voice']} @ {entry['speed']}x")


if __name__ == "__main__":
    main()
