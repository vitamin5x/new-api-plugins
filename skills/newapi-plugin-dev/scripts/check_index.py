#!/usr/bin/env python3
"""Verify a plugin repository's index against the files on disk.

`pluginindex check` already compares the index to the plugin sources. This script
covers what it does not, and what actually breaks an install:

  * every version listed in index.json really exists at its `path`
  * every plugin.js hashes to the `sha256` the index declares
  * every plugin.js is LF-only and BOM-free, because the gateway hashes the raw
    bytes and a CRLF checkout would disagree with the index
  * every version declared by the index has a sibling CHANGELOG.md
  * the sidecar icon, when present, hashes to its declared sha256

A mismatch here is an install failure for every gateway, not a warning.

Usage:
    python check_index.py [repo-root]
    python check_index.py /c/projects/new-api-plugins

`repo-root` defaults to the current directory. Exit code 0 when consistent.
"""

import hashlib
import json
import sys
from pathlib import Path


def sha256_of(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def check_file(root, entry, label, problems):
    """Verify one index entry points at an existing, byte-exact file."""
    relative = entry.get("path")
    if not relative:
        problems.append(f"{label}: entry has no path")
        return None

    path = root / relative
    if not path.is_file():
        problems.append(f"{label}: {relative} is missing on disk")
        return None

    raw = path.read_bytes()
    actual = hashlib.sha256(raw).hexdigest()
    declared = entry.get("sha256")
    if declared and actual != declared:
        problems.append(
            f"{label}: {relative} hashes to {actual} but the index declares {declared}"
        )
    return path


def main(argv):
    root = Path(argv[1] if len(argv) > 1 else ".").resolve()
    index_path = root / "index.json"

    if not index_path.is_file():
        print(f"FAIL {index_path} not found; is this a plugin repository root?")
        return 2

    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        print(f"FAIL index.json is not valid JSON: {error}")
        return 1

    problems = []
    plugins = index.get("plugins") or []
    if not plugins:
        problems.append("index declares no plugins")

    total_versions = 0
    for plugin in plugins:
        key = plugin.get("key", "?")
        versions = plugin.get("versions") or []
        latest = plugin.get("latest")
        total_versions += len(versions)

        if not versions:
            problems.append(f"{key}: declares no versions")
            continue

        names = [entry.get("version") for entry in versions]
        if latest and latest not in names:
            problems.append(f"{key}: latest {latest!r} is not among versions {names}")

        for entry in versions:
            version = entry.get("version", "?")
            label = f"{key}@{version}"
            path = check_file(root, entry, label, problems)
            if path is None:
                continue

            raw = path.read_bytes()
            if raw[:3] == b"\xef\xbb\xbf":
                problems.append(f"{label}: {path.name} starts with a BOM")
            if b"\r" in raw:
                problems.append(
                    f"{label}: {path.name} contains CRLF; the gateway hashes raw bytes"
                )

            changelog = path.parent / "CHANGELOG.md"
            if not changelog.is_file():
                problems.append(f"{label}: no sibling CHANGELOG.md at {changelog}")

        icon = plugin.get("iconFile")
        if icon:
            check_file(root, icon, f"{key} icon", problems)

    if problems:
        print(f"FAIL {index_path}")
        for problem in problems:
            print(f"  - {problem}")
        print(f"\n{len(problems)} problem(s) across {len(plugins)} plugin(s)")
        return 1

    print(f"OK   {index_path}")
    print(f"     {len(plugins)} plugin(s), {total_versions} version(s), all hashes match")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
