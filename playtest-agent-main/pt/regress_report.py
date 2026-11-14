"""Regression table for a run report."""
from html import escape


def render(result):
    def e(value):
        return escape(str(value), quote=True)
    rows = []
    for row in result.get("reports", []):
        rows.append('<tr>' + ''.join(f'<td>{e(row.get(key, ""))}</td>' for key in ("title", "step", "verdict", "quote", "cost_usd")) + '</tr>')
    goal = result.get("goal_replay")
    if goal:
        verdict = "new breakage" if goal.get("new_breakage") else "no new breakage"
        detail = (f'Won before: {goal.get("old_won")}. Won now: {goal.get("won")}. '
                  f'First different step: {goal.get("first_different_step")}. '
                  f'Baseline replay won: {goal.get("baseline_replay_won")}. {goal.get("baseline_source", "")}')
        rows.append(f'<tr><td>Goal replay</td><td>{e(goal.get("first_different_step"))}</td><td>{e(verdict)}</td><td>{e(detail)}</td><td>0.0</td></tr>')
    counts = result.get("counts", {})
    summary = ', '.join(f'{counts.get(key, 0)} {key}' for key in ("fixed", "still there", "new breakage"))
    return ('<section aria-labelledby="regression-title"><h2 id="regression-title">Regression</h2>'
            f'<p>{e(summary)}</p><p>Old run: {e(result.get("old_run", ""))}. '
            f'New build bugs: {e(result.get("bugs_on", ""))}. Cost: ${e(result.get("cost_usd", 0))}.</p>'
            '<table><thead><tr><th>Report</th><th>Step</th><th>Verdict</th><th>Quote</th><th>Cost</th></tr></thead><tbody>'
            + ''.join(rows) + '</tbody></table></section>')
