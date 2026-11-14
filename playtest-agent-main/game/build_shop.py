"""Build the shop refund fixture from Cave Courier."""
from pathlib import Path


def _once(text, anchor, replacement):
    if text.count(anchor) != 1:
        raise ValueError("Expected one insertion point: " + anchor)
    return text.replace(anchor, replacement)


def build(source=None, target=None):
    folder = Path(__file__).resolve().parent
    source = Path(source) if source is not None else folder / "index.html"
    target = Path(target) if target is not None else folder / "shop.html"
    if source.resolve() == target.resolve():
        raise ValueError("The shop page must be a copy")
    text = source.read_text(encoding="utf-8")
    text = _once(text, "6: false};", "6: false, 8: false};")
    text = _once(text, "coins: 0, score: 0,", "coins: 0, score: 0, refunds: 0,")
    text = _once(text, "if (st.boots) return say('You already have boots.');", """if (st.boots) {
        st.boots = false;
        st.coins += BUGS.has(8) ? 4 : 3;
        st.refunds++;
        if (BUGS.has(8)) window.__bugHit[8] = true;
        say('Boots returned.');
        return;
      }""")
    text = _once(text, "coins: st.coins, score: st.score,", "coins: st.coins, score: st.score, refunds: st.refunds,")
    target.write_text(text, encoding="utf-8", newline="\n")
    return target


if __name__ == "__main__":
    print(build())
