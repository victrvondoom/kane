"""Summarize play and confirmation costs from saved run folders."""
import argparse
import json
from pathlib import Path


COLUMNS = [
    ("run", "run"), ("play_steps", "play steps"), ("play_model_calls", "play model calls"),
    ("play_cost_usd", "play cost $"), ("play_seconds", "play seconds"),
    ("reports", "reports"), ("replays", "replays"), ("replay_steps", "replay steps"),
    ("judge_calls", "judge calls"), ("check_cost_usd", "check cost $"),
    ("check_seconds", "check seconds"), ("checks_pct_cost", "checks as % of cost"),
]


def collect(run_dirs):
    rows = []
    for run_dir in run_dirs:
        folder = Path(run_dir)
        result = json.loads((folder / "result.json").read_text(encoding="utf-8"))
        reports = result.get("reports", [])
        row = {
            "run": folder.name,
            "play_steps": result.get("steps", "n/a"),
            "play_model_calls": result.get("calls", len(result["log"]) if isinstance(result.get("log"), list) else "n/a"),
            "play_cost_usd": result.get("cost_usd", "n/a"),
            "play_seconds": result.get("seconds", "n/a"),
            "reports": len(reports),
            "replays": len(reports) * 2,
            "replay_steps": sum(2 * (report["step"] + 1) for report in reports),
        }
        confirm_path = folder / "confirm.json"
        if not confirm_path.exists():
            row.update(judge_calls="not confirmed", check_cost_usd="not confirmed",
                       check_seconds="not confirmed", checks_pct_cost="not confirmed")
        else:
            confirms = json.loads(confirm_path.read_text(encoding="utf-8"))
            row["judge_calls"] = sum(bool(item.get("reproducible")) for item in confirms)
            row["check_cost_usd"] = sum(item.get("cost_usd", 0) for item in confirms)
            row["check_seconds"] = sum(item["seconds"] for item in confirms) if all("seconds" in item for item in confirms) else "not saved"
            row["checks_pct_cost"] = round(row["check_cost_usd"] / row["play_cost_usd"] * 100, 1) if isinstance(row["play_cost_usd"], (int, float)) and row["play_cost_usd"] else "n/a"
        rows.append(row)
    rows.append(_total(rows))
    return rows


def _total(rows):
    fields = [key for key, _ in COLUMNS if key not in ("run", "checks_pct_cost", "check_seconds")]
    total = {"run": "total"}
    for key in fields:
        vals = [row[key] for row in rows if isinstance(row.get(key), (int, float))]
        total[key] = sum(vals) if vals else "n/a"
    confirmed = all(row["check_seconds"] != "not confirmed" for row in rows)
    saved = confirmed and all(row["check_seconds"] != "not saved" for row in rows)
    total["check_seconds"] = sum(row["check_seconds"] for row in rows) if saved else ("not confirmed" if not confirmed else "not saved")
    cost = total.get("play_cost_usd")
    total["checks_pct_cost"] = round(total["check_cost_usd"] / cost * 100, 1) if cost else "n/a"
    return total


def _fmt(value, key=None):
    if isinstance(value, float):
        if key in ("play_cost_usd", "check_cost_usd"):
            return f"{value:.4f}"
        return f"{value:.1f}" if value % 1 else str(int(value))
    if isinstance(value, int) and key in ("play_cost_usd", "check_cost_usd"):
        return f"{value:.4f}"
    return str(value)


def render(rows):
    headings = [heading for _, heading in COLUMNS]
    lines = ["| " + " | ".join(headings) + " |", "| " + " | ".join("---" for _ in headings) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(_fmt(row[key], key) for key, _ in COLUMNS) + " |")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runs", nargs="+", type=Path, metavar="RUN")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args(argv)
    rows = collect(args.runs)
    print(json.dumps(rows, indent=2) if args.as_json else render(rows))


if __name__ == "__main__":
    main()
