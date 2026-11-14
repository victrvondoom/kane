"""Apply one exact unified diff in memory, without shell commands or path access."""
import re

HUNK = re.compile(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n?\Z")


def apply_edits(source, edits):
    """Apply ordered replacements only when each search has one exact match."""
    if not isinstance(edits, list):
        raise ValueError("Invalid edits")
    if not edits:
        raise ValueError("No edits")
    for edit in edits:
        if (not isinstance(edit, dict) or set(edit) != {"search", "replace"}
                or not all(isinstance(value, str) for value in edit.values())):
            raise ValueError("Invalid edit")
        search, replace = (edit[key].replace("\r\n", "\n") for key in ("search", "replace"))
        if not search or search not in source:
            raise ValueError("Search text not found")
        if source.count(search) != 1:
            raise ValueError("Search text is not unique")
        if replace == search:
            raise ValueError("Edit changes nothing")
        source = source.replace(search, replace, 1)
    return source


def apply_diff(source, diff):
    """Only index-buggy-view.html may change. No fuzz, renames, modes or extra files."""
    if not isinstance(diff, str) or not diff:
        raise ValueError("Empty diff does not apply")
    lines = diff.replace("\r\n", "\n").splitlines(keepends=True)
    pos = 0
    if lines[0].startswith("diff --git "):
        if lines[0].rstrip("\n") != "diff --git a/index-buggy-view.html b/index-buggy-view.html":
            raise ValueError("Diff path must be index-buggy-view.html only")
        pos += 1
        if pos < len(lines) and re.fullmatch(r"index [0-9a-f]+\.\.[0-9a-f]+(?: 100644)?\n?", lines[pos]):
            pos += 1
    for prefix, allowed in (("--- ", {"index-buggy-view.html", "a/index-buggy-view.html"}),
                            ("+++ ", {"index-buggy-view.html", "b/index-buggy-view.html"})):
        if pos >= len(lines) or not lines[pos].startswith(prefix):
            raise ValueError("Diff path headers are missing")
        name = lines[pos][len(prefix):].rstrip("\n").split("\t", 1)[0]
        if name not in allowed:
            raise ValueError("Diff path must be index-buggy-view.html only")
        pos += 1
    original, output, cursor, hunks, changes = source.splitlines(keepends=True), [], 0, 0, 0
    while pos < len(lines):
        match = HUNK.fullmatch(lines[pos])
        if not match:
            raise ValueError("Unexpected diff content or extra path")
        old_start, old_count, new_start, new_count = (
            int(x) if x is not None else 1 for x in match.groups())
        start = old_start - 1 if old_count else old_start
        if start < cursor or start > len(original):
            raise ValueError("Hunk does not apply at that line")
        output.extend(original[cursor:start])
        if (new_start - 1 if new_count else new_start) != len(output):
            raise ValueError("New hunk position does not apply")
        cursor, removed, added = start, 0, 0
        pos += 1
        while removed < old_count or added < new_count:
            if pos >= len(lines) or lines[pos][:1] not in (" ", "-", "+"):
                raise ValueError("Hunk length does not apply")
            kind, value = lines[pos][0], lines[pos][1:]
            pos += 1
            if pos < len(lines) and lines[pos].rstrip("\n") == "\\ No newline at end of file":
                value = value.removesuffix("\n")
                pos += 1
            if kind in (" ", "-"):
                if cursor >= len(original) or original[cursor] != value:
                    raise ValueError("Hunk context does not apply")
                cursor += 1
                removed += 1
            if kind in (" ", "+"):
                output.append(value)
                added += 1
            changes += kind != " "
        if (removed, added) != (old_count, new_count):
            raise ValueError("Hunk counts do not apply")
        hunks += 1
    if not hunks or not changes:
        raise ValueError("Diff has no changes")
    output.extend(original[cursor:])
    return "".join(output)
