"""Bake a plain game view, then add private replay instrumentation."""
import re
from pathlib import Path


# Whole lines are deliberate: a changed or ambiguous anchor has no known hook.
ANCHORS = {
    1: "    for (const s of S) if (overlap(box, s)) { box.x = st.vx > 0 ? s.x - W : s.x + s.w; }",
    2: "    st.x = box.x + W / 2;",
    3: "      say('Thanks! Enjoy the boots!');",
    4: "        if (st.y > GROUND) { continue; }",
    5: "      if (c.id === 3) { st.score += 1; } else st.score += 10;",
    6: "    st.x = box.x + W / 2;",
}
INSERTIONS = {
    1: "    for (const s of S) if (s.door === 1 && st.shedOpen && overlap(box, s)) window.__bugHit[1] = true;\n" + ANCHORS[1],
    2: ANCHORS[2] + "\n    if (st.x > 300 && st.x < 330 && box.y > GROUND - H) window.__bugHit[2] = true;",
    3: "      if (!st.boots) window.__bugHit[3] = true;\n" + ANCHORS[3],
    4: ANCHORS[4].replace("continue;", "window.__bugHit[4] = true; continue;"),
    5: ANCHORS[5].replace("st.score += 1;", "st.score += 1; window.__bugHit[5] = true;"),
    6: "    if (typeof OPTIONS !== 'undefined' && OPTIONS.has(6) && st.x > 80 && st.x < 300 && box.y > GROUND - H) window.__bugHit[6] = true;",
}


def hook_anchors(view):
    """Return hooks whose fixed anchor occurs exactly once in this view."""
    lines = view.splitlines()
    return {n for n, anchor in ANCHORS.items() if lines.count(anchor) == 1}


def instrument(view):
    """Insert hooks only at intact anchors; missing hooks start as unknown."""
    if "__bugHit" in view:
        raise ValueError("The view must not contain replay hooks")
    if view.splitlines().count("(() => {") != 1:
        raise ValueError("Game entry point changed; cannot add replay hooks")
    known = hook_anchors(view)
    fields = ", ".join(f"{n}: {'false' if n in known else 'null'}" for n in range(1, 7))
    output = []
    for line in view.splitlines(keepends=True):
        text = line.removesuffix("\n")
        if text == "(() => {":
            output.append(line)
            output.append(f"  window.__bugHit = {{{fields}}};\n")
            continue
        matches = [n for n in known if ANCHORS[n] == text]
        if matches:
            output.append("\n".join(INSERTIONS[n] for n in sorted(matches)) + "\n")
        else:
            output.append(line)
        # Test controls belong to the harness page, never the model's view.
        if text == "  const q = new URLSearchParams(location.search);":
            output.append("  const DEBUG = q.get('debug') === '1';\n")
        if text.startswith("  window.__state = "):
            output.append("  if (DEBUG) window.__debug = {set: (a) => { for (const k of Object.keys(a)) st[k] = a[k]; st.vx = 0; st.vy = 0; }};\n")
    return "".join(output)


def _once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("Cave Courier source changed; review the bake step: " + old)
    return source.replace(old, new)


def bake(source):
    """Fold flags 1 to 5 and remove all harness hints from the model view."""
    source = re.sub(r"<!--.*?-->", "<!-- Cave Courier. MIT licence, see LICENSE. -->", source, count=1, flags=re.S)
    # The remaining optional flag uses its existing query name without a tell in the view.
    source = _once(source,
                   "const BUGS = new Set((q.get('bugs') || '').split(',').filter(Boolean).map(Number));",
                   "const OPTIONS = new Set((q.get('b' + 'ugs') || '').split(',').filter(Boolean).map(Number).filter(n => n === 6));")
    source = re.sub(r"^.*(?:const DEBUG =|window\.__debug|window\.__bugHit =).*\n", "", source, flags=re.M)
    source = re.sub(r"\s*//.*(?:bug [1-6]:|clean build|fall-through zone).*", "", source)
    source = re.sub(r"^.*if \(BUGS\.has\([26]\) &&.*window\.__bugHit.*\n", "", source, flags=re.M)
    source = re.sub(r"if \(BUGS\.has\(1\)\) window\.__bugHit\[1\] = true; ", "", source)
    source = re.sub(r"window\.__bugHit\[[1-6]\] = true; ?", "", source)
    replacements = (
        ("BUGS.has(4) ? 350 : 320", "350"),
        ("    if (!BUGS.has(2)) s.push({x: 300, y: GROUND, w: 30, h: 110});\n", ""),
        ("if (!st.shedOpen || BUGS.has(1)) ", ""),
        ("if (BUGS.has(3)) { say('Thanks! Enjoy the boots!'); }\n      else { st.boots = true; say('You bought boots. Jump twice!'); }",
         "say('Thanks! Enjoy the boots!');"),
        ("BUGS.has(4) && ", ""),
        ("BUGS.has(5) && ", ""),
        ("if (BUGS.has(2)) earth(300, GROUND, 30, 110, true);", "earth(300, GROUND, 30, 110, true);"),
        ("if (BUGS.has(2)) { g.fillStyle = '#4d5c4a'; g.fillRect(300, GROUND, 30, 110); }",
         "g.fillStyle = '#4d5c4a'; g.fillRect(300, GROUND, 30, 110);"),
    )
    for old, new in replacements:
        source = _once(source, old, new)
    source = source.replace("BUGS.has(6)", "OPTIONS.has(6)")
    if "bug" in source.lower() or "BUGS.has(" in source or hook_anchors(source) != set(range(1, 7)):
        raise ValueError("Cave Courier view changed; review the bake step")
    return source


def build(source=None, target=None):
    folder = Path(__file__).resolve().parent
    source = Path(source) if source is not None else folder / "index.html"
    target = Path(target) if target is not None else folder / "index-buggy.html"
    view_target = target.with_name(target.stem + "-view.html")
    if source.resolve() in {target.resolve(), view_target.resolve()}:
        raise ValueError("The baked targets must be copies")
    view = bake(source.read_text(encoding="utf-8"))
    served = instrument(view)
    view_target.write_text(view, encoding="utf-8", newline="\n")
    target.write_text(served, encoding="utf-8", newline="\n")
    return target


if __name__ == "__main__":
    print(build())
