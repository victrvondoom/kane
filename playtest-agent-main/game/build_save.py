"""Build the save point fixture from Cave Courier without editing its source."""
from pathlib import Path


def _once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("Save fixture insertion point must occur once: " + old)
    return source.replace(old, new)


def build(source):
    source = _once(source, "6: false};", "6: false, 7: false};")
    source = _once(source, "    coins = [{x: 120", "    st.savedTick = null;\n    coins = [{x: 120")
    source = _once(source, "  reset();\n  const say", """  reset();
  const saved = localStorage.getItem('cave-courier-save');
  if (saved) {
    const progress = JSON.parse(saved);
    for (const field of ['coins', 'score', 'key', 'boots', 'shedOpen', 'doorOpen', 'x', 'y']) {
      if (Object.hasOwn(progress, field)) st[field] = progress[field];
    }
    const collected = JSON.parse(localStorage.getItem('cave-courier-save-items') || '[]');
    for (const coin of coins) coin.got = collected.includes(coin.id);
    st.keyItem.got = st.key;
  }
  const say"""
    )
    source = _once(source, "  function use() {", """  function use() {
    if (Math.abs(st.x - 120) <= 20 && st.ground) {
      const {coins: coinCount, score, key, boots, shedOpen, doorOpen, x, y} = st;
      const progress = {coins: coinCount, score, key, boots, shedOpen, doorOpen, x, y};
      if (BUGS.has(7)) {
        delete progress.boots;
        if (st.boots) window.__bugHit[7] = true;
      }
      // Keep collected items gone so loading at the stone cannot collect its coin again.
      localStorage.setItem('cave-courier-save-items', JSON.stringify(coins.filter(c => c.got).map(c => c.id)));
      localStorage.setItem('cave-courier-save', JSON.stringify(progress));
      st.savedTick = window.__frame;
      say('Game saved.');
      return;
    }"""
    )
    source = _once(source, "        reset(); continue;", "        localStorage.removeItem('cave-courier-save');\n        localStorage.removeItem('cave-courier-save-items');\n        reset(); continue;")
    source = _once(source, "    g.fillStyle = '#fff'; g.font = '12px monospace';", """    g.fillStyle = '#8acacc'; g.fillRect(113, GROUND - 16, 14, 16);
    g.font = '9px monospace'; g.fillText('SAVE E', 103, GROUND - 20);
    g.fillStyle = '#fff'; g.font = '12px monospace';"""
    )
    source = _once(source, "doorOpen: st.doorOpen});", "doorOpen: st.doorOpen, savedTick: st.savedTick});")
    return source


def main():
    folder = Path(__file__).resolve().parent
    result = build((folder / "index.html").read_text(encoding="utf-8"))
    (folder / "save.html").write_text(result, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
