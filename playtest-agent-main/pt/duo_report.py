"""The two players' observations and messages beside each other."""
import html
import json


def render(result):
    if result.get("kind") != "duo":
        return ""
    escape = lambda value: html.escape(str(value), quote=True)
    columns = []
    for player in (1, 2):
        lines = []
        for line in result.get("log", []):
            if line.get("player") != player:
                continue
            calls = "\n".join(call.get("name", "") + ": " + json.dumps(call.get("args", {}), ensure_ascii=False)
                              for call in line.get("calls", []))
            lines.append(f'<article><h4>Turn {escape(line.get("step", ""))}</h4>'
                         f'<p>{escape(line.get("text", ""))}</p><pre>{escape(calls)}</pre>'
                         f'<p>Keys dropped: {escape(line.get("dropped_keys", 0))}</p></article>')
        reports = "".join(f'<p><strong>Report:</strong> {escape(rep.get("title", ""))}</p>'
                          for rep in result.get("reports", []) if rep.get("player") == player)
        columns.append(f'<div><h3>Player {player}</h3>{reports}{"".join(lines)}</div>')
    return ('<section><h2>Players</h2><div class="duo-lines">' + "".join(columns) + '</div></section>'
            '<style>.duo-lines{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}'
            '.duo-lines article{padding:12px;border:1px solid var(--border);margin:12px 0}'
            '.duo-lines pre{white-space:pre-wrap;overflow-wrap:anywhere}'
            '@media(max-width:600px){.duo-lines{grid-template-columns:1fr}}</style>')
