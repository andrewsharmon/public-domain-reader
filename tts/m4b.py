#!/usr/bin/env python
"""Package a render as one audiobook file with chapter markers.

    python m4b.py --book <slug>                   # the default profile
    python m4b.py --book <slug> --profile slow

The reader plays a render one chapter file at a time, and needs the Mac
serving it. An .m4b holds the same audio as a single file that Apple Books
imports and plays offline, chapters and all, with nothing else running.

Nothing is re-encoded. The chapter files are already AAC in MP4 -- what
afconvert writes -- so this copies their compressed frames into one new MP4
and adds a chapter track. It uses only the standard library: no ffmpeg, no
third-party MP4 library, and nothing that would need shipping. What it cannot
do is make AAC from MP3, so a render made without an AAC encoder (see
render.py) cannot become an m4b.

The container is ISO/IEC 14496-12 (the MP4 file format). Chapters are a
QuickTime text track referenced from the audio track with `tref/chap`, which
is what Apple Books and AVFoundation read.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LIBRARY = ROOT.parent / "library"

# Seconds between 1904-01-01, where MP4 timestamps start, and the Unix epoch.
MAC_EPOCH = 2082844800

# Frames per chunk in the output. A chunk is just a run of samples stored
# together; small ones keep seeking cheap for players that read whole chunks.
CHUNK_FRAMES = 64

# Copying reads contiguous frames together, up to this much at a time: a
# five-hour chapter is one contiguous run, and not worth holding in memory.
COPY_BYTES = 8 << 20


# ------------------------------------------------------------------- reading


def boxes(data: bytes, start: int = 0, end: int | None = None):
    """Yield (type, box_start, payload_start, box_end) for each box in a span."""
    end = len(data) if end is None else end
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack_from(">I4s", data, pos)
        header = 8
        if size == 1:
            size = struct.unpack_from(">Q", data, pos + 8)[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            raise ValueError(f"malformed {kind!r} box at byte {pos}")
        yield kind, pos, pos + header, pos + size
        pos += size


def find(data: bytes, start: int, end: int, path: str):
    """The (box_start, payload_start, box_end) of the first box along a path."""
    found = None
    for name in path.split("/"):
        for kind, box_start, payload, box_end in boxes(data, start, end):
            if kind == name.encode("latin1"):
                found = (box_start, payload, box_end)
                start, end = payload, box_end
                break
        else:
            return None
    return found


@dataclass
class Track:
    """One chapter file's audio: where each compressed frame is, and its config."""
    path: Path
    timescale: int
    stsd: bytes                  # the sample description, copied verbatim
    durations: list[int]         # per frame, in timescale units
    sizes: list[int]             # per frame, in bytes
    offsets: list[int]           # per frame, absolute byte offset in the file

    @property
    def length(self) -> int:
        return sum(self.durations)


def read_moov(path: Path) -> bytes:
    """The moov box, read without loading the audio around it."""
    with path.open("rb") as f:
        pos = 0
        while True:
            f.seek(pos)
            header = f.read(16)
            if len(header) < 8:
                raise ValueError(f"{path.name}: no moov box")
            size, kind = struct.unpack_from(">I4s", header)
            if size == 1:
                size = struct.unpack_from(">Q", header, 8)[0]
            elif size == 0:
                size = f.seek(0, 2) - pos
            if kind == b"moov":
                f.seek(pos)
                return f.read(size)
            pos += size


def read_track(path: Path) -> Track:
    moov = read_moov(path)
    trak = None
    for kind, _, payload, end in boxes(moov, 8):
        if kind == b"trak":
            hdlr = find(moov, payload, end, "mdia/hdlr")
            if hdlr and moov[hdlr[1] + 8:hdlr[1] + 12] == b"soun":
                trak = (payload, end)
                break
    if not trak:
        raise ValueError(f"{path.name}: no audio track")

    mdhd = find(moov, *trak, "mdia/mdhd")[1]
    version = moov[mdhd]
    timescale = struct.unpack_from(">I", moov, mdhd + (20 if version == 1 else 12))[0]

    stbl = find(moov, *trak, "mdia/minf/stbl")
    table = lambda name: find(moov, stbl[1], stbl[2], name)  # noqa: E731

    stsd = table("stsd")
    if struct.unpack_from(">I", moov, stsd[1] + 4)[0] != 1:
        raise ValueError(f"{path.name}: expected one sample description")

    stts = table("stts")[1]
    durations = []
    for i in range(struct.unpack_from(">I", moov, stts + 4)[0]):
        count, delta = struct.unpack_from(">II", moov, stts + 8 + 8 * i)
        durations += [delta] * count

    stsz = table("stsz")[1]
    default, count = struct.unpack_from(">II", moov, stsz + 4)
    sizes = [default] * count if default else list(struct.unpack_from(f">{count}I", moov, stsz + 12))

    stco = table("stco") or table("co64")
    wide = moov[stco[0] + 4:stco[0] + 8] == b"co64"
    chunks = struct.unpack_from(">I", moov, stco[1] + 4)[0]
    chunk_offsets = struct.unpack_from(f">{chunks}{'Q' if wide else 'I'}", moov, stco[1] + 8)

    stsc = table("stsc")[1]
    runs = [struct.unpack_from(">III", moov, stsc + 8 + 12 * i)
            for i in range(struct.unpack_from(">I", moov, stsc + 4)[0])]

    # Expand the chunk table into one byte offset per frame.
    offsets = []
    frame = 0
    for r, (first, per_chunk, _) in enumerate(runs):
        last = runs[r + 1][0] - 1 if r + 1 < len(runs) else chunks
        for chunk in range(first - 1, last):
            position = chunk_offsets[chunk]
            for _ in range(per_chunk):
                offsets.append(position)
                position += sizes[frame]
                frame += 1

    if not (len(durations) == len(sizes) == len(offsets)):
        raise ValueError(f"{path.name}: sample tables disagree")

    return Track(path, timescale, moov[stsd[0]:stsd[2]], durations, sizes, offsets)


def bitrate_fields(stsd: bytes) -> int:
    """Offset, within an AAC sample description, of its three bitrate fields.

    The esds box describes the stream as nested MPEG-4 descriptors. Its
    DecoderConfigDescriptor holds the codec, then a buffer size and maximum
    and average bitrates -- 11 bytes that differ from file to file for the
    same encoder settings, because they describe the audio that happened to
    be encoded. Everything else must match for frames to be joined.
    """
    def descriptor(pos: int) -> tuple[int, int, int]:
        tag, length, pos = stsd[pos], 0, pos + 1
        for _ in range(4):
            byte = stsd[pos]
            pos += 1
            length = (length << 7) | (byte & 0x7F)
            if not byte & 0x80:
                break
        return tag, length, pos

    esds = stsd.find(b"esds")
    if esds == -1:
        raise ValueError("not an AAC sample description")
    tag, _, pos = descriptor(esds + 8)  # past the type and the version/flags
    if tag != 0x03:
        raise ValueError("unexpected esds layout")
    flags = stsd[pos + 2]
    pos += 3
    if flags & 0x80:
        pos += 2
    if flags & 0x40:
        pos += 1 + stsd[pos]
    if flags & 0x20:
        pos += 2
    tag, _, pos = descriptor(pos)
    if tag != 0x04:
        raise ValueError("unexpected esds layout")
    return pos + 2  # past the object type and stream type


def joined_description(tracks: list[Track]) -> bytes:
    """One sample description for every chapter, or an error if they differ."""
    first = tracks[0]
    at = bitrate_fields(first.stsd)
    neutral = lambda t: t.stsd[:at] + bytes(11) + t.stsd[at + 11:]  # noqa: E731
    for track in tracks[1:]:
        if track.timescale != first.timescale or neutral(track) != neutral(first):
            raise ValueError(
                f"{track.path.name} was encoded differently from {first.path.name}; "
                "an m4b needs every chapter in the same format")

    buffer = max(int.from_bytes(t.stsd[at:at + 3], "big") for t in tracks)
    peak = max(struct.unpack_from(">I", t.stsd, at + 3)[0] for t in tracks)
    seconds = sum(t.length for t in tracks) / first.timescale
    average = round(sum(sum(t.sizes) for t in tracks) * 8 / seconds)
    return first.stsd[:at] + buffer.to_bytes(3, "big") + struct.pack(">II", peak, average) + first.stsd[at + 11:]


# ------------------------------------------------------------------- writing


def box(kind: bytes, *parts: bytes) -> bytes:
    payload = b"".join(parts)
    if len(payload) + 8 > 0xFFFFFFFF:
        return struct.pack(">I4sQ", 1, kind, len(payload) + 16) + payload
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def full_box(kind: bytes, version: int, flags: int, *parts: bytes) -> bytes:
    return box(kind, struct.pack(">I", (version << 24) | flags), *parts)


# The identity transform, as every track and movie header carries one.
MATRIX = struct.pack(">9I", 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)


def run_length(values: list[int]) -> list[tuple[int, int]]:
    """[(count, value)] for runs of equal values."""
    runs: list[list[int]] = []
    for value in values:
        if runs and runs[-1][1] == value:
            runs[-1][0] += 1
        else:
            runs.append([1, value])
    return [(c, v) for c, v in runs]


def sample_tables(stsd: bytes, durations: list[int], sizes: list[int],
                  chunks: list[int], chunk_offsets: list[int], wide: bool) -> bytes:
    """An stbl box from per-sample durations and sizes and per-chunk frame counts."""
    stts = run_length(durations)
    stsc = []
    for index, count in enumerate(chunks, start=1):
        if not stsc or stsc[-1][1] != count:
            stsc.append((index, count))
    fixed = len(set(sizes)) == 1
    return box(
        b"stbl",
        stsd,
        full_box(b"stts", 0, 0, struct.pack(">I", len(stts)), *(struct.pack(">II", c, d) for c, d in stts)),
        full_box(b"stsc", 0, 0, struct.pack(">I", len(stsc)), *(struct.pack(">III", f, n, 1) for f, n in stsc)),
        full_box(b"stsz", 0, 0, struct.pack(">II", sizes[0] if fixed else 0, len(sizes)),
                 b"" if fixed else struct.pack(f">{len(sizes)}I", *sizes)),
        full_box(b"co64" if wide else b"stco", 0, 0, struct.pack(">I", len(chunk_offsets)),
                 struct.pack(f">{len(chunk_offsets)}{'Q' if wide else 'I'}", *chunk_offsets)),
    )


def track_header(track_id: int, duration_ms: int, enabled: bool, audio: bool, now: int) -> bytes:
    # Flag 1 is "enabled", 2 "in movie". The chapter track is neither: it is
    # data for the player to read, not something to present.
    return full_box(
        b"tkhd", 0, 0x3 if enabled else 0,
        struct.pack(">IIIII", now, now, track_id, 0, duration_ms),
        bytes(8),
        struct.pack(">hhhH", 0, 0, 0x0100 if audio else 0, 0),
        MATRIX,
        struct.pack(">II", 0, 0),
    )


def media_header(timescale: int, duration: int, now: int) -> bytes:
    # Language "und", packed as three five-bit letters.
    return full_box(b"mdhd", 0, 0, struct.pack(">IIIIHH", now, now, timescale, duration, 0x55C4, 0))


def handler(kind: bytes, name: str) -> bytes:
    return full_box(b"hdlr", 0, 0, struct.pack(">I4sIII", 0, kind, 0, 0, 0), name.encode() + b"\0")


DATA_INFO = box(b"dinf", full_box(b"dref", 0, 0, struct.pack(">I", 1), full_box(b"url ", 0, 1)))


# A QuickTime text sample description, all defaults: no display flags, black
# on white, the default font. The chapter titles are its samples.
TEXT_DESCRIPTION = box(
    b"stsd",
    struct.pack(">I", 0),  # version and flags
    struct.pack(">I", 1),  # one entry
    box(
        b"text",
        bytes(6), struct.pack(">H", 1),     # reserved, data reference 1
        struct.pack(">Ii", 0, 0),            # display flags, justification
        struct.pack(">3H", 0, 0, 0),         # background colour
        struct.pack(">4h", 0, 0, 0, 0),      # default text box
        bytes(8),                            # reserved
        struct.pack(">HHBH", 0, 0, 0, 0),    # font number, face, reserved x2
        struct.pack(">3H", 0, 0, 0),         # foreground colour
        b"\0",                               # empty font name
    ),
)

# The text track's media header: QuickTime's base media information header,
# and the text media information that goes with it.
TEXT_MEDIA_HEADER = box(
    b"gmhd",
    full_box(b"gmin", 0, 0, struct.pack(">HHHHhH", 0x40, 0x8000, 0x8000, 0x8000, 0, 0)),
    box(b"text", MATRIX),
)


def chapter_sample(title: str) -> bytes:
    # A length-prefixed string, then an encoding box marking it UTF-8.
    text = title.encode("utf-8")[:0xFFFF]
    return struct.pack(">H", len(text)) + text + box(b"encd", struct.pack(">I", 0x100))


def ilst_text(kind: bytes, value: str) -> bytes:
    return box(kind, box(b"data", struct.pack(">II", 1, 0), value.encode("utf-8")))


def metadata(title: str, artist: str) -> bytes:
    items = [ilst_text(b"\xa9nam", title), ilst_text(b"\xa9alb", title), ilst_text(b"\xa9gen", "Audiobook")]
    if artist:
        items.append(ilst_text(b"\xa9ART", artist))
    return box(
        b"udta",
        full_box(b"meta", 0, 0, full_box(b"hdlr", 0, 0, struct.pack(">I4s4sII", 0, b"mdir", b"appl", 0, 0), b"\0"),
                 box(b"ilst", *items)),
    )


@dataclass
class Chapter:
    title: str
    track: Track


def write_m4b(chapters: list[Chapter], out: Path, title: str, artist: str) -> list[float]:
    """Write the audiobook; returns each chapter's start in seconds."""
    first = chapters[0].track
    timescale = first.timescale
    description = joined_description([c.track for c in chapters])

    durations = [d for c in chapters for d in c.track.durations]
    sizes = [s for c in chapters for s in c.track.sizes]

    # Chunks never span two chapter files, so each chapter starts on a chunk.
    audio_chunks = []
    for chapter in chapters:
        frames = len(chapter.track.sizes)
        audio_chunks += [CHUNK_FRAMES] * (frames // CHUNK_FRAMES) + ([frames % CHUNK_FRAMES] if frames % CHUNK_FRAMES else [])

    # A chapter starts where its file's first frame does. That frame begins
    # with the encoder's lead-in, near silence, so the marker can only land a
    # fraction of a second before the first word -- never inside it.
    starts = []
    position = 0
    for chapter in chapters:
        starts.append(position)
        position += chapter.track.length
    total = position

    titles = [chapter_sample(c.title) for c in chapters]
    title_durations = [b - a for a, b in zip(starts, starts[1:] + [total])]

    audio_bytes = sum(sizes)
    text_bytes = sum(len(t) for t in titles)
    wide = audio_bytes + text_bytes + (1 << 20) > 0xFFFFFFFF

    now = int(time.time()) + MAC_EPOCH
    duration_ms = round(total * 1000 / timescale)

    ftyp = box(b"ftyp", b"M4B ", struct.pack(">I", 0), b"M4B ", b"M4A ", b"mp42", b"isom")

    def movie(audio_offsets: list[int], text_offset: int) -> bytes:
        audio = box(
            b"trak",
            track_header(1, duration_ms, enabled=True, audio=True, now=now),
            box(b"tref", box(b"chap", struct.pack(">I", 2))),
            box(
                b"mdia",
                media_header(timescale, total, now),
                handler(b"soun", "SoundHandler"),
                box(b"minf", full_box(b"smhd", 0, 0, struct.pack(">hH", 0, 0)), DATA_INFO,
                    sample_tables(description, durations, sizes, audio_chunks, audio_offsets, wide)),
            ),
        )
        text = box(
            b"trak",
            track_header(2, duration_ms, enabled=False, audio=False, now=now),
            box(
                b"mdia",
                media_header(timescale, total, now),
                handler(b"text", "TextHandler"),
                box(b"minf", TEXT_MEDIA_HEADER, DATA_INFO,
                    sample_tables(TEXT_DESCRIPTION, title_durations, [len(t) for t in titles],
                                  [len(titles)], [text_offset], wide)),
            ),
        )
        mvhd = full_box(
            b"mvhd", 0, 0,
            struct.pack(">IIII", now, now, 1000, duration_ms),
            struct.pack(">IH", 0x10000, 0x0100), bytes(10), MATRIX, bytes(24),
            struct.pack(">I", 3),
        )
        return box(b"moov", mvhd, audio, text, metadata(title, artist))

    # The chunk offsets depend on where the audio lands, which depends on how
    # big the moov in front of it is. Its size does not depend on the offsets'
    # values, so build it once with placeholders to measure it.
    placeholder = movie([0] * len(audio_chunks), 0)
    mdat_header = 16 if wide else 8
    data_start = len(ftyp) + len(placeholder) + mdat_header

    audio_offsets = []
    position = data_start
    frame = 0
    for count in audio_chunks:
        audio_offsets.append(position)
        position += sum(sizes[frame:frame + count])
        frame += count
    text_offset = position

    moov = movie(audio_offsets, text_offset)
    assert len(moov) == len(placeholder)

    partial = out.with_suffix(".m4b.partial")
    with partial.open("wb") as f:
        f.write(ftyp)
        f.write(moov)
        payload = audio_bytes + text_bytes
        f.write(struct.pack(">I4sQ", 1, b"mdat", payload + 16) if wide else struct.pack(">I4s", payload + 8, b"mdat"))
        for chapter in chapters:
            copy_frames(chapter.track, f)
        for t in titles:
            f.write(t)
    partial.replace(out)

    return [s / timescale for s in starts]


def copy_frames(track: Track, out) -> None:
    """Copy a track's frames in order, reading contiguous runs at once."""
    with track.path.open("rb") as src:
        i = 0
        while i < len(track.offsets):
            start = track.offsets[i]
            length = track.sizes[i]
            j = i + 1
            while j < len(track.offsets) and track.offsets[j] == start + length and length < COPY_BYTES:
                length += track.sizes[j]
                j += 1
            src.seek(start)
            data = src.read(length)
            if len(data) != length:
                raise ValueError(f"{track.path.name} is shorter than its sample table says")
            out.write(data)
            i = j


# ---------------------------------------------------------------- the book


def display_name(author: str) -> tuple[str, bool]:
    """'Jowett, Benjamin, 1817-1893 [Translator]' -> ('Benjamin Jowett', False).

    Catalogue entries carry dates and roles; a player shows a name. The flag
    says whether this is an author rather than a translator or editor.
    """
    role = re.search(r"\[(.+?)\]", author)
    parts = [p.strip() for p in re.sub(r"\[.+?\]", "", author).split(",")]
    parts = [p for p in parts if p and not re.search(r"\d", p)]
    name = f"{parts[1]} {parts[0]}" if len(parts) >= 2 else (parts[0] if parts else "")
    return name, role is None


def artist_for(authors: list[str]) -> str:
    named = [display_name(a) for a in authors or []]
    primary = [n for n, is_author in named if n and is_author]
    return " & ".join(primary or [n for n, _ in named if n])


def still_matches(rendered: str | None, current: str | None) -> bool:
    # The rule the server and render.py apply: nothing to compare is trusted.
    return rendered is None or current is None or rendered == current


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--book", required=True, help="library folder name")
    parser.add_argument("--profile", default="default", help="which render to package")
    parser.add_argument("--out", type=Path, help="where to write it; default book.m4b beside the render")
    args = parser.parse_args()

    book_dir = LIBRARY / args.book
    render_dir = book_dir / "audio" / args.profile
    try:
        book = json.loads((book_dir / "book.json").read_text())
        sync = json.loads((render_dir / "sync.json").read_text())
    except FileNotFoundError as err:
        sys.exit(f"Nothing to package: {err.filename} does not exist.")
    meta = {}
    if (book_dir / "meta.json").exists():
        meta = json.loads((book_dir / "meta.json").read_text())

    current = {c["index"]: c for c in book["chapters"]}
    rendered = sorted(sync.get("chapters", []), key=lambda c: c["index"])
    if not rendered:
        sys.exit("This render has no chapters yet.")

    # Audio from a chapter that has changed since would be filed under the
    # wrong title, or under a chapter that no longer exists.
    stale = [c for c in rendered
             if c["index"] not in current or not still_matches(c.get("fingerprint"), current[c["index"]].get("fingerprint"))]
    if stale:
        print("These chapters changed after they were rendered, so their audio no longer fits:")
        for c in stale:
            print(f"  {c['index']:>3}  {c.get('title') or ''}")
        sys.exit(f"\nRender them again first:  render.py --book {args.book} --chapters <n>")

    not_aac = [c for c in rendered if not c["file"].endswith(".m4a")]
    if not_aac:
        sys.exit(
            f"{not_aac[0]['file']} is not AAC. An m4b needs AAC, and this render was made without an AAC "
            "encoder -- on macOS, afconvert provides one.")

    chapters = [
        Chapter(current[c["index"]].get("title") or c.get("title") or f"Chapter {c['index']}",
                read_track(render_dir / c["file"]))
        for c in rendered
    ]

    title = meta.get("title") or book.get("title") or args.book
    artist = artist_for(meta.get("authors") or book.get("authors") or [])
    out = args.out or render_dir / "book.m4b"
    starts = write_m4b(chapters, out, title, artist)

    missing = [c for i, c in current.items() if i not in {r["index"] for r in rendered} and not c.get("frontMatter")]
    print(f"{title}{f' — {artist}' if artist else ''}")
    for chapter, start in zip(chapters, starts):
        hours, rest = divmod(int(start), 3600)
        print(f"  {hours:d}:{rest // 60:02d}:{rest % 60:02d}  {chapter.title}")
    if missing:
        print(f"\n  not rendered, so not included: {', '.join(c.get('title') or str(c['index']) for c in missing)}")
    print(f"\n  {out}  ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
