"""Which parts of a book get spoken, and the profiles that decide it.

Shared by render.py, which skips these sections, and m4b.py, which has to say
why they are missing from an audiobook. Standard library only, because m4b.py
runs without the speech environment.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Sections that are reference material rather than prose. An index is
# thousands of fragments -- names, commas, page numbers -- which is hours of
# synthesis producing something nobody would ever listen to.
DEFAULT_SKIP_TITLES = [
    r"^\s*INDEX\b", r"^\s*FOOTNOTES?\b", r"^\s*BIBLIOGRAPHY\b",
    r"^\s*CONTENTS\b", r"TRANSCRIBER'?S NOTE", r"PRINTER TO THE UNIVERSITY",
]


def load_profile(name: str, required: bool = True) -> dict:
    path = ROOT / "profiles" / f"{name}.json"
    if not path.exists():
        if required:
            sys.exit(f"No such profile: {path}")
        return {}
    profile = json.loads(path.read_text())
    # Keys beginning with an underscore are documentation for whoever edits
    # the profile by hand, not settings.
    return {k: v for k, v in profile.items() if not k.startswith("_")}


def skip_patterns_for(profile: dict, include_reference: bool = False) -> list[str]:
    # Present-but-empty means "skip nothing", so this tests for the key rather
    # than for a truthy value -- `[]` must not fall back to the defaults.
    if include_reference:
        return []
    return profile["skipTitles"] if "skipTitles" in profile else DEFAULT_SKIP_TITLES


def should_skip(title: str, patterns: list[str]) -> bool:
    return bool(title) and any(re.search(p, title, re.I) for p in patterns)
