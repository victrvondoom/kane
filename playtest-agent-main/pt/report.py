"""Build a standalone HTML report for one playtest run."""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import statistics
from datetime import datetime
from pathlib import Path
from typing import Any

from pt import report_checks


def _escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _display_number(value: float) -> str:
    return f"{value:g}"


def _step_number(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _badge(confirmation: dict[str, Any] | None) -> str:
    if confirmation is None:
        return "Unverified"
    if confirmation.get("status") == "input refused in replay":
        return "Input refused"
    if confirmation.get("status") == "not compared":
        return "Not compared"
    if confirmation.get("reproducible") is False:
        return "Not reproducible"
    if confirmation.get("confirmed") is True:
        return "Confirmed"
    if confirmation.get("confirmed") is False:
        return "Not confirmed"
    if confirmation.get("status") == "confirmed":
        return "Confirmed"
    if confirmation.get("status") == "rejected":
        return "Not confirmed"
    return "Unverified"


def confirmation_status(confirmation):
    if not isinstance(confirmation, dict):
        return "unverified"
    if confirmation.get("status") == "input refused in replay":
        return "input refused in replay"
    if confirmation.get("status") == "not compared":
        return "not compared"
    if confirmation.get("reproducible") is True and confirmation.get("confirmed") is True:
        return "confirmed"
    if confirmation.get("reproducible") is False or confirmation.get("confirmed") is False:
        return "rejected"
    if confirmation.get("status") in ("confirmed", "rejected"):
        return confirmation["status"]
    return "unverified"


def _image_link(filename: str, alt: str, class_name: str) -> str:
    safe_name = _escape(filename)
    return (
        f'<a class="{class_name}" href="{safe_name}" target="_blank" rel="noopener">'
        f'<img src="{safe_name}" alt="{_escape(alt)}"></a>'
    )


def _load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def _report_card(
    report: dict[str, Any],
    confirmation: dict[str, Any] | None,
    index: int,
    run_dir: Path,
) -> str:
    step = report.get("step", "?")
    image_name = f"strip_{index}.jpg"
    if not (run_dir / image_name).is_file():
        numeric_step = _step_number(step)
        image_name = f"s{numeric_step:03d}.jpg" if numeric_step is not None else ""
        if not image_name or not (run_dir / image_name).is_file():
            image_name = ""

    image = _image_link(image_name, f"Filmstrip for report {index + 1}", "report-image") if image_name else ""
    second = f"strip_{index}_b.jpg"
    if (run_dir / second).is_file():
        image += _image_link(second, f"Second replay for report {index + 1}", "report-image")
    image = f'<div class="replay-images">{image}</div>' if image else ""
    badge = _badge(confirmation)
    badge_class = {
        "Confirmed": "confirmed",
        "Not confirmed": "not-confirmed",
        "Not reproducible": "not-reproducible",
        "Not compared": "not-compared",
        "Input refused": "input-refused",
        "Unverified": "not-checked",
    }[badge]
    evidence = ""
    if confirmation is not None:
        evidence_value = confirmation.get("evidence") or confirmation.get("judge")
        if evidence_value:
            evidence = f'<p><strong>Evidence</strong> {_escape(evidence_value)}</p>'
        change = confirmation.get("state_change")
        if isinstance(change, list) and change:
            evidence += f'<p><strong>State change</strong> {_escape("; ".join(str(c) for c in change))}</p>'

    return (
        '<article class="bug-card">'
        f'<div class="card-heading"><h3>{_escape(report.get("title", "Untitled report"))}</h3>'
        f'<span class="badge {badge_class}">{badge}</span></div>'
        f'<p><strong>Expected</strong> {_escape(report.get("expected", ""))}</p>'
        f'<p><strong>Seen</strong> {_escape(report.get("actual", ""))}</p>'
        f'<p><strong>Step</strong> {_escape(step)}</p>'
        f'{evidence}{report_checks.replays(confirmation)}{image}'
        f'{report_checks.saved_checks(run_dir, index, report)}</article>'
    )


def _timeline(run_dir: Path, log: list[Any]) -> str:
    log_by_step: dict[int, Any] = {}
    for entry in log:
        if not isinstance(entry, dict):
            continue
        step = _step_number(entry.get("step"))
        if step is not None:
            log_by_step.setdefault(step, entry)

    screenshots: list[tuple[int, str]] = []
    for path in run_dir.iterdir():
        match = re.fullmatch(r"s(\d+)\.jpg", path.name, re.IGNORECASE)
        if match and path.is_file():
            screenshots.append((int(match.group(1)), path.name))

    if not screenshots:
        return ""

    tiles: list[str] = []
    for step, filename in sorted(screenshots):
        entry = log_by_step.get(step, {})
        note = entry.get("text", "") if isinstance(entry, dict) else ""
        note_text = str(note)[:140] if note else ""
        note_html = f'<p class="step-note">{_escape(note_text)}</p>' if note_text else ""
        tiles.append(
            '<figure class="timeline-item">'
            f'{_image_link(filename, f"Screenshot for step {step}", "timeline-image")}'
            f'<figcaption><strong>Step {_escape(step)}</strong>{note_html}</figcaption>'
            '</figure>'
        )
    return '<section aria-labelledby="timeline-title"><h2 id="timeline-title">Timeline</h2><div class="timeline">' + "".join(tiles) + "</div></section>"


def _summary(reports: list[Any], confirmations: list[Any]) -> str:
    rows = {
        "Reports filed": len(reports),
        "Confirmed": 0,
        "Not confirmed": 0,
        "Not reproducible": 0,
        "Not compared": 0,
        "Input refused": 0,
    }
    for index in range(len(reports)):
        confirmation = confirmations[index] if index < len(confirmations) and isinstance(confirmations[index], dict) else None
        if confirmation is None:
            continue
        if confirmation.get("status") == "input refused in replay":
            rows["Input refused"] += 1
        elif confirmation.get("status") == "not compared":
            rows["Not compared"] += 1
        elif confirmation.get("reproducible") is False:
            rows["Not reproducible"] += 1
        elif confirmation.get("confirmed") is True:
            rows["Confirmed"] += 1
        elif confirmation.get("confirmed") is False:
            rows["Not confirmed"] += 1

    if rows["Input refused"] == 0:
        del rows["Input refused"]
    body = "".join(
        f'<tr><th scope="row">{_escape(label)}</th><td>{_escape(value)}</td></tr>'
        for label, value in rows.items()
    )
    return '<section aria-labelledby="summary-title"><h2 id="summary-title">Summary</h2><table><tbody>' + body + "</tbody></table></section>"


def _cost_table(result: dict[str, Any], steps: int, log: list[Any]) -> str:
    total = _number(result.get("cost_usd"))
    rows = [f'<tr><th scope="row">Total cost</th><td>${_escape(f"{total:.2f}")}</td></tr>']
    if steps > 0:
        per_step = total / steps
        rows.append(f'<tr><th scope="row">Cost per step</th><td>${_escape(_display_number(per_step))}</td></tr>')

    latencies = [
        _number(entry["latency_s"])
        for entry in log
        if isinstance(entry, dict) and "latency_s" in entry
    ]
    if latencies:
        median = statistics.median(latencies)
        rows.append(
            f'<tr><th scope="row">Median seconds per step</th><td>{_escape(_display_number(median))} s</td></tr>'
        )
    return '<section aria-labelledby="cost-title"><h2 id="cost-title">Cost</h2><table><tbody>' + "".join(rows) + "</tbody></table></section>"


def _ended(result: dict[str, Any]) -> str:
    """How the run ended: the agent's last words, the settings, and any resend after a lost server state. Left out when there is nothing to say."""
    parts = []
    if result.get("position_source") == "sam":
        sam = result.get("sam") or {}
        parts.append(f'<p>position from SAM: {_escape(sam.get("calls", 0))} calls, ${_number(sam.get("cost_usd")):.4f}</p>')
    final = result.get("final_text")
    if isinstance(final, str) and final.strip():
        parts.append(f"<p><strong>The agent said</strong> {_escape(final.strip())}</p>")
    st = result.get("settings")
    if isinstance(st, dict) and st:
        bits = []
        bits.append(f"vision {st.get('vision', 'normal')}")
        if st.get("effort"):
            bits.append(f"reasoning effort {st['effort']}")
        if "state_text" in st:
            bits.append("game state sent as text" if st["state_text"] else "screenshots only")
        parts.append(f"<p><strong>Settings</strong> {_escape(', '.join(bits))}</p>")
    fb = result.get("fallbacks")
    if isinstance(fb, int) and fb > 0:
        parts.append(f"<p><strong>Server fault</strong> the history was resent {fb} time(s) after the server lost its copy.</p>")
    if not parts:
        return ""
    return '<section aria-labelledby="ended-title"><h2 id="ended-title">How the run ended</h2>' + "".join(parts) + "</section>"


def build(run_dir: str | Path) -> str:
    """Return the report page for a run folder."""
    directory = Path(run_dir)
    result = _load_json(directory / "result.json", {})
    if not isinstance(result, dict):
        result = {}

    reports = result.get("reports", [])
    if not isinstance(reports, list):
        reports = []
    log = result.get("log", [])
    if not isinstance(log, list):
        log = []
    confirmations = _load_json(directory / "confirm.json", [])
    if not isinstance(confirmations, list):
        confirmations = []

    steps_value = _step_number(result.get("steps", 0))
    steps = max(steps_value or 0, 0)
    seconds = _number(result.get("seconds"))
    cost = _number(result.get("cost_usd"))
    kind = str(result.get("kind", ""))
    game = str(result.get("game") or "Game")
    stop = result.get("stop", "unknown")
    try:
        modified = datetime.fromtimestamp((directory / "result.json").stat().st_mtime).date().isoformat()
    except OSError:
        modified = "Unknown date"

    goal_status = ""
    if kind == "goal":
        goal_status = f'<p class="goal-status">{"Goal reached" if result.get("won") is True else "Goal not reached"}</p>'

    report_cards: list[tuple[int, int, str]] = []
    for index, report in enumerate(reports):
        if not isinstance(report, dict):
            continue
        numeric_step = _step_number(report.get("step"))
        sort_key = numeric_step if numeric_step is not None else 2**31 - 1
        confirmation = confirmations[index] if index < len(confirmations) and isinstance(confirmations[index], dict) else None
        report_cards.append((sort_key, index, _report_card(report, confirmation, index, directory)))
    report_cards.sort(key=lambda item: (item[0], item[1]))
    cards_html = "".join(card for _, _, card in report_cards)
    if cards_html:
        cards_section = '<section aria-labelledby="reports-title"><h2 id="reports-title">Bug reports</h2><div class="bug-list">' + cards_html + "</div></section>"
    else:
        cards_section = ""

    regression_html = ""
    regression = _load_json(directory / "regress.json", None)
    if isinstance(regression, dict):
        from pt.regress_report import render
        regression_html = render(regression)
    ended_html = _ended(result)
    from pt.fix_report import render as render_fixes
    fixes = _load_json(directory / "fix.json", None)
    fixes_html = render_fixes(fixes, directory) if isinstance(fixes, dict) else ""
    summary_html = _summary(reports, confirmations) if kind == "hunt" else ""
    timeline_html = _timeline(directory, log)
    from pt.duo_report import render as render_duo
    duo_html = render_duo(result)
    from pt.diary import load as load_diary
    diary_items = "".join(f'<li>Step {_escape(x.get("step"))}: {_escape(x.get("text", ""))} '
                          f'<a href="{_escape(x.get("frame", ""))}">frame</a></li>' for x in load_diary(directory))
    diary_html = f'<section aria-labelledby="diary-title"><h2 id="diary-title">Playtest diary</h2><ol>{diary_items}</ol></section>' if diary_items else ""
    cost_html = _cost_table(result, steps, log)
    run_line = (
        f'<p class="run-line">Stopped: {_escape(stop)}. {_escape(steps)} steps, '
        f'{_escape(_display_number(seconds))} s, ${_escape(f"{cost:.2f}")}.</p>'
    )
    signoff = _load_json(directory / "signoff.json", None)
    if isinstance(signoff, dict) and isinstance(signoff.get("manifest"), dict):
        from pt.seal import check, digest
        changed = check(directory, signoff["manifest"])
        if digest(signoff["manifest"]) != signoff.get("digest"):
            changed.append("manifest")
        signoff_line = ("Sign off withdrawn: evidence changed after sign off: " + _escape(", ".join(changed[:3]))
                        if changed else "Signed off by " + _escape(signoff.get("by", "")))
    elif isinstance(signoff, dict):
        signoff_line = "Signed off by " + _escape(signoff.get("by", "")) + " (not sealed)"
    else:
        signoff_line = "Not signed off"
    console_link = '<p><a href="console.html">Run console</a></p>' if (directory / "console.html").is_file() else ""

    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_escape(game)} report</title>
<style>
:root {{
  color-scheme: light dark;
  --page: light-dark(#f4f6f8, #101419);
  --surface: light-dark(#ffffff, #1b2229);
  --text: light-dark(#17212b, #edf2f6);
  --muted: light-dark(#596773, #aeb9c2);
  --border: light-dark(#d7dfe5, #394650);
  --link: light-dark(#155ca8, #8bbcff);
  --good-bg: light-dark(#e2f3e7, #183725);
  --good-text: light-dark(#17612f, #9be0ac);
  --warn-bg: light-dark(#fff1d6, #493719);
  --warn-text: light-dark(#785000, #ffd17b);
  --quiet-bg: light-dark(#e9edf0, #303941);
  --quiet-text: light-dark(#47535d, #c1cbd2);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--page);
  color: var(--text);
}}
@media (prefers-color-scheme: dark) {{ :root {{ color-scheme: dark; }} }}
@media (prefers-color-scheme: light) {{ :root {{ color-scheme: light; }} }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--page); color: var(--text); line-height: 1.5; }}
main {{ max-width: 1120px; margin: 0 auto; padding: 28px 16px 48px; }}
h1, h2, h3, p {{ margin-top: 0; }}
h1 {{ margin-bottom: 8px; font-size: clamp(1.7rem, 6vw, 2.4rem); }}
h2 {{ margin: 28px 0 12px; font-size: 1.35rem; }}
h3 {{ margin: 0; font-size: 1.1rem; overflow-wrap: anywhere; }}
.meta, .step-note {{ color: var(--muted); }}
.run-line {{ margin-bottom: 4px; }}
.goal-status {{ font-weight: 700; }}
section {{ margin-top: 24px; }}
table {{ width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }}
th, td {{ padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; }}
tr:last-child th, tr:last-child td {{ border-bottom: 0; }}
th {{ font-weight: 600; }}
.bug-list {{ display: grid; gap: 14px; }}
.bug-card {{ min-width: 0; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }}
.bug-card p {{ margin: 10px 0 0; overflow-wrap: anywhere; }}
.card-heading {{ display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }}
.badge {{ flex: 0 0 auto; padding: 3px 9px; border-radius: 999px; font-size: .85rem; font-weight: 700; }}
.confirmed {{ color: var(--good-text); background: var(--good-bg); }}
.not-confirmed {{ color: var(--warn-text); background: var(--warn-bg); }}
.not-reproducible, .not-checked, .not-compared, .input-refused {{ color: var(--quiet-text); background: var(--quiet-bg); }}
.replay-images {{ display: flex; flex-wrap: wrap; gap: 14px; }}
.report-image {{ display: block; flex: 1 1 280px; max-width: 640px; margin-top: 14px; }}
img {{ display: block; max-width: 100%; height: auto; border-radius: 8px; }}
a {{ color: var(--link); }}
.timeline {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 190px), 1fr)); gap: 12px; }}
.timeline-item {{ min-width: 0; margin: 0; padding: 9px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }}
.timeline-image {{ display: block; }}
.timeline-item figcaption {{ margin-top: 8px; overflow-wrap: anywhere; }}
.timeline-item .step-note {{ margin: 3px 0 0; font-size: .92rem; }}
@media (max-width: 480px) {{ main {{ padding-top: 20px; }} .card-heading {{ flex-wrap: wrap; }} }}
</style>
</head>
<body>
<main>
<header>
<h1>{_escape(game)}</h1>
<p class="meta">{_escape(kind)} run · {_escape(modified)}</p>
{run_line}
{goal_status}
<p>{signoff_line}</p>
{console_link}
</header>
{summary_html}
{regression_html}
{fixes_html}
{ended_html}
{cards_section}
{duo_html}
{diary_html}
{timeline_html}
{cost_html}
</main>
</body>
</html>
'''


def write(run_dir: str | Path) -> Path:
    """Write report.html in the run folder and return its path."""
    directory = Path(run_dir)
    output = directory / "report.html"
    output.write_text(build(directory), encoding="utf-8")
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build an HTML report for a playtest run")
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args(argv)
    write(args.run_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
