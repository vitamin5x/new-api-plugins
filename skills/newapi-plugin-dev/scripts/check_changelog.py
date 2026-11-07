#!/usr/bin/env python3
"""Validate a plugin CHANGELOG.md against the repository's release-notes format.

Why this script exists: `pluginindex check` validates plugin source, directory
names, and index hashes. It does NOT validate changelogs. A changelog with a
wrong version heading, a translated category name, or a nested list passes the
index check and still breaks the marketplace release-notes contract.

Usage:
    python check_changelog.py <CHANGELOG.md> [more...]
    python check_changelog.py plugins/tasks/kj-sd/1.0.1/CHANGELOG.md

Exit code 0 when every file is valid, 1 otherwise.
"""

import re
import sys
from pathlib import Path

REQUIRED_META = ("changelogVersion", "plugin", "version", "locale")

# The only category headings the format allows. Keep this list in sync with
# docs/marketplace.md#release-notes.
CATEGORIES = {
    "Added",
    "Changed",
    "Deprecated",
    "Removed",
    "Fixed",
    "Security",
    "Migration",
}


def parse_front_matter(text):
    """Return (meta dict, body). Front matter is delimited by leading --- lines."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None, text
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            meta = {}
            for line in lines[1:index]:
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                match = re.match(r"^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$", line)
                if not match:
                    continue
                value = match.group(2).strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                meta[match.group(1)] = value
            return meta, "\n".join(lines[index + 1 :])
    return None, text


def check(path):
    """Return a list of human-readable problems; empty means valid."""
    problems = []
    raw = path.read_bytes()

    if raw[:3] == b"\xef\xbb\xbf":
        problems.append("file starts with a UTF-8 BOM; the format requires plain UTF-8")
    if b"\r" in raw:
        problems.append("file contains CRLF line endings; the repository is LF-only")

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        problems.append(f"file is not valid UTF-8: {error}")
        return problems

    meta, body = parse_front_matter(text)
    if meta is None:
        problems.append("missing YAML front matter delimited by --- lines")
        return problems

    for key in REQUIRED_META:
        if not meta.get(key):
            problems.append(f"front matter is missing required key {key!r}")

    version = meta.get("version", "")
    if version and not re.match(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$", version):
        problems.append(f"front matter version {version!r} is not semver")

    # The directory tells us what the plugin and version must be, which catches
    # a changelog copied from another version and never edited. This assumes the
    # canonical layout, plugins/<kind>/<key>/<version>/CHANGELOG.md, so a file in
    # a scratch path reports a spurious mismatch: run it on the real path.
    expected_version = path.parent.name
    if version and version != expected_version:
        problems.append(
            f"front matter version {version!r} does not match directory {expected_version!r}"
        )
    expected_plugin = path.parent.parent.name
    if meta.get("plugin") and meta["plugin"] != expected_plugin:
        problems.append(
            f"front matter plugin {meta['plugin']!r} does not match directory {expected_plugin!r}"
        )

    if body.count("\n# Changelog") + (1 if body.startswith("# Changelog") else 0) != 1:
        problems.append("body must contain exactly one '# Changelog' heading")

    version_headings = re.findall(r"^## \[([^\]]+)\]", body, re.M)
    if not version_headings:
        problems.append("no '## [<version>]' release heading")
    elif version_headings[0] != version:
        problems.append(
            f"first release heading is {version_headings[0]!r}, expected {version!r}"
        )
    duplicates = {name for name in version_headings if version_headings.count(name) > 1}
    if duplicates:
        problems.append(f"duplicate release headings: {sorted(duplicates)}")

    # Category headings appear as '### Name'. Anything else is a format error,
    # including a translated category name.
    seen_categories = []
    for heading in re.findall(r"^### (.+)$", body, re.M):
        name = heading.strip()
        if name not in CATEGORIES:
            problems.append(
                f"unknown category heading {name!r}; allowed: {', '.join(sorted(CATEGORIES))}"
            )
        else:
            seen_categories.append(name)

    # Tables are not part of the format.
    for line in body.split("\n"):
        if re.match(r"^\s*\|.*\|\s*$", line):
            problems.append("body contains a Markdown table, which the format does not allow")
            break

    # Nested list items. Anchor on real indentation spaces only: `\\s` matches
    # newlines under re.M and would flag a top-level bullet as nested.
    for line in body.split("\n"):
        if re.match(r"^ {2,}[-*+] \S", line):
            problems.append(
                "body contains a nested list item; one bullet per change, no nesting"
            )
            break

    # Every category must have at least one bullet, and bullets must not be empty.
    sections = re.split(r"^### (.+)$", body, flags=re.M)
    if len(sections) > 1:
        for index in range(1, len(sections), 2):
            name = sections[index].strip()
            content = sections[index + 1] if index + 1 < len(sections) else ""
            bullets = [line for line in content.split("\n") if re.match(r"^[-*+] ", line)]
            if name in CATEGORIES and not bullets:
                problems.append(f"category {name!r} has no bullet entries")

    if not seen_categories and not version_headings:
        problems.append("body has neither a release heading nor any category")

    return problems


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip())
        return 2

    failed = 0
    for argument in argv[1:]:
        path = Path(argument)
        if not path.is_file():
            print(f"FAIL {argument}: not a file")
            failed += 1
            continue
        problems = check(path)
        if problems:
            failed += 1
            print(f"FAIL {argument}")
            for problem in problems:
                print(f"  - {problem}")
        else:
            print(f"OK   {argument}")

    if failed:
        print(f"\n{failed} file(s) failed")
        return 1
    print(f"\nall {len(argv) - 1} file(s) valid")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
