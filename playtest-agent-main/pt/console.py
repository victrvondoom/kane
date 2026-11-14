"""Write a local console for a saved run."""
import html
import json
from pathlib import Path

from pt.report import _badge, _load_json, _number


def escape(value):
    return html.escape(str(value), quote=True)


def _checklist(items, step):
    rows = []
    for item in items:
        done = item.get("done") and item.get("step", 0) <= step
        mark = "✓" if done else "☐"
        evidence = item.get("evidence", "") if done else ""
        rows.append(f'<li>{mark} {escape(item.get("text", ""))} {escape(evidence)}</li>')
    return '<h2>Checklist</h2><ul>' + "".join(rows) + '</ul>' if rows else ""


def build(folder):
    folder = Path(folder)
    result = _load_json(folder / "result.json", {})
    confirmations = _load_json(folder / "confirm.json", [])
    entries = result.get("log") or [{"step": 0, "text": result.get("final_text", ""), "calls": []}]
    entries = list(entries)
    known = {entry.get("step", 0) for entry in entries}
    marker_steps = {rep.get("step", 0) for rep in result.get("reports", [])}
    escalation = result.get("escalation") or {}
    if escalation:
        marker_steps.add(escalation.get("step", 0))
    for step in sorted(marker_steps - known):
        entries.append({"step": step, "text": "", "calls": []})
    entries.sort(key=lambda entry: entry.get("step", 0))
    from pt.diary import load as load_diary
    diary = load_diary(folder)
    frames, running = [], 0
    for index, entry in enumerate(entries):
        step = entry.get("step", 0)
        cost = _number(entry.get("cost"))
        running += cost
        calls = []
        for call in entry.get("calls", []):
            output = call.get("output", "done" if call.get("name") == "act" else "noted")
            calls.append(f'<li><strong>{escape(call.get("name", ""))}</strong>'
                         f'<pre>{escape(json.dumps(call.get("args", {}), ensure_ascii=False, indent=2))}</pre>'
                         f'<p>Output: {escape(output)}</p></li>')
        markers = []
        for i, rep in enumerate(result.get("reports", [])):
            if rep.get("step", 0) == step:
                confirmation = confirmations[i] if i < len(confirmations) else None
                markers.append(f'<p class="marker">Report: {escape(rep.get("title", ""))} '
                               f'<span class="badge">{escape(_badge(confirmation))}</span></p>')
        if escalation and escalation.get("step", 0) == step:
            markers.append(f'<aside><strong>NEEDS A PERSON: {escape(escalation.get("question", ""))}</strong>'
                           f'<p>{escape(escalation.get("reason", ""))}</p></aside>')
        markers += [f'<p class="marker">Diary: {escape(x.get("text", ""))}</p>' for x in diary if x.get("step") == step]
        items = entry.get("checklist", result.get("checklist", []))
        frames.append(f'<section class="frame"{ " hidden" if index else ""}>'
                      f'<h2>Step {escape(step)}</h2><img src="s{int(step):03d}.jpg" alt="Screenshot for step {escape(step)}">'
                      f'<p class="model">{escape(entry.get("text", ""))}</p><ol>{"".join(calls)}</ol>'
                      f'<p>Cost ${cost:.5f}. Latency {_number(entry.get("latency_s")):g} s. Running cost ${running:.5f}.</p>'
                      f'{"".join(markers)}{_checklist(items, step)}</section>')
    return '''<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Run console</title><style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 16px; max-width: 960px; line-height: 1.5; }
nav { position: sticky; top: 0; background: Canvas; padding: 12px 0; }
button { padding: 12px; cursor: pointer; font: inherit; }
progress { display: block; width: 100%; margin-top: 12px; }
img { display: block; max-width: 100%; height: auto; border-radius: 8px; }
pre, .model { white-space: pre-wrap; overflow-wrap: anywhere; }
li, aside, .marker { overflow-wrap: anywhere; }
aside, .marker { border: 1px solid GrayText; border-radius: 8px; padding: 12px; }
.badge { font-weight: bold; }
[hidden] { display: none; }
@media (max-width: 480px) { body { padding: 8px; } button { padding: 10px; } }
</style></head><body><h1>Run console</h1>
<nav aria-label="Step controls"><button id="previous">Previous</button>
<button id="next">Next</button><button id="play">Play to end</button>
<span id="position" aria-live="polite"></span><progress id="progress" value="1" max="1"></progress></nav>
''' + '<p>Vision: ' + escape(result.get("settings", {}).get("vision", "normal")) + '</p>' + "".join(frames) + '''
<script>
const frames = Array.from(document.querySelectorAll('.frame'));
const previous = document.getElementById('previous');
const next = document.getElementById('next');
const play = document.getElementById('play');
const progress = document.getElementById('progress');
const position = document.getElementById('position');
let current = 0, timer = null;
function stop() { clearInterval(timer); timer = null; play.textContent = 'Play to end'; }
function show(index) {
  current = Math.max(0, Math.min(frames.length - 1, index));
  frames.forEach((frame, i) => { frame.hidden = i !== current; });
  previous.disabled = current === 0;
  next.disabled = current === frames.length - 1;
  progress.max = frames.length;
  progress.value = current + 1;
  position.textContent = `${current + 1} / ${frames.length}`;
  if (current === frames.length - 1) stop();
}
previous.onclick = () => { stop(); show(current - 1); };
next.onclick = () => { stop(); show(current + 1); };
play.onclick = () => {
  if (timer) { stop(); return; }
  if (current === frames.length - 1) show(0);
  play.textContent = 'Pause';
  timer = setInterval(() => show(current + 1), 1000);
};
document.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); stop(); show(current + (event.key === 'ArrowRight' ? 1 : -1));
  }
});
show(0);
</script></body></html>
'''


def write(folder):
    folder = Path(folder)
    output = folder / "console.html"
    output.write_text(build(folder), encoding="utf-8")
    return output
