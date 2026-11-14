"""Show each proposed diff and its independent replay verdicts."""
from html import escape
import json

from pt.fix import summary


def render(result, directory):
    def e(value):
        return escape(str(value), quote=True)
    cards = []
    for row in result.get("reports", []):
        index = row.get("report_index")
        if type(index) is not int or index < 0:
            continue
        try:
            diff = (directory / "fixes" / str(index) / "patch.diff").read_text(encoding="utf-8")
        except FileNotFoundError:
            diff = "Diff unavailable"
        history = []
        for attempt in row.get("attempts", [])[:-1]:
            number = attempt.get("try")
            if type(number) is not int or number < 1:
                continue
            folder = directory / "fixes" / str(index) / "attempts" / str(number)
            try:
                prior = json.loads((folder / "verdict.json").read_text(encoding="utf-8"))
                prior_diff = (folder / "patch.diff").read_text(encoding="utf-8")
            except FileNotFoundError:
                continue
            history.append(f'<details><summary>Attempt {number}: '
                           f'{"proved" if prior.get("proved") else "rejected"}</summary>'
                           f'<p>Applied: {e(prior.get("applied"))}. '
                           f'Bug gone: {e(prior.get("bug_gone"))}. '
                           f'Goal still won: {e(prior.get("goal_won"))}. '
                           f'Hook: {e(prior.get("hook", "unknown"))}. '
                           f'Hooks clear: {e(prior.get("hooks_clear"))}.</p>'
                           f'<p>{e(prior.get("quote", ""))}</p><p>{e(prior.get("failure", ""))}</p>'
                           f'<pre style="overflow:auto"><code>{e(prior_diff)}</code></pre></details>')
        handoff = (f'<p>Needs a person after {e(row.get("tries"))} tries</p>'
                   if index in result.get("needs_human", []) else '')
        cards.append('<article class="bug-card">'
                     f'<h3>{e(row.get("title", ""))}</h3>'
                     f'<p><strong>{"Proved" if row.get("proved") else "Rejected"}</strong></p>'
                     f'<p>Applied: {e(row.get("applied"))}. '
                     f'Bug gone: {e(row.get("bug_gone"))}. Goal still won: {e(row.get("goal_won"))}. '
                     f'Hook: {e(row.get("hook", "unknown"))}. '
                     f'Hooks clear: {e(row.get("hooks_clear"))}. Proved: {e(row.get("proved"))}.</p>'
                     f'<p>{e(row.get("quote", ""))}</p><p>{e(row.get("why", ""))}</p>'
                     f'<p>{e(row.get("failure", ""))}</p>'
                     f'<p>Tries: {e(row.get("tries"))}. Cost: ${e(row.get("cost_usd"))}.</p>'
                     + handoff + f'<pre style="overflow:auto"><code>{e(diff)}</code></pre>'
                     + ''.join(history) + '</article>')
    return ('<section aria-labelledby="fix-title"><h2 id="fix-title">Fixes</h2>'
            f'<p>{e(summary(result))}; '
            f'{e(result.get("line_changed_judge_fixed", 0))} line changed, judge says fixed. '
            f'Baked build: {e(result.get("build"))}. '
            f'Cost: ${e(result.get("cost_usd", 0))}.</p>'
            '<p>the hook check can not see a hook whose line the patch changed.</p>'
            + ''.join(cards) + '</section>')
