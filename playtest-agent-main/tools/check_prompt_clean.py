"""Check model-facing hunt text for terms from an external list."""
import argparse
import json
import re
import sys
from pathlib import Path

from pt import cli, loop
from pt.adapter import ROOT, config_path, load_config


def build_text(game):
    """Build hunt text using the same prompt and tool functions as the playing loop."""
    cfg = load_config(config_path(game))
    controls = cfg.get("controls", "") or ""
    brief = ""
    brief_path = cfg.get("brief_file")
    if brief_path:
        path = Path(brief_path)
        if not path.is_absolute():
            path = ROOT / path
        brief = path.read_text(encoding="utf-8")
        if "{" in brief or "}" in brief:
            raise ValueError("brief must not contain braces")
        controls += "\n\n" + brief
    args = cli.parse(["hunt", "prompt-clean-check", "--game", game])
    hunt = cli.run_settings(args, cfg.get("goal", ""))["goal"]
    instructions = loop.SYSTEM.format(controls=controls or "keyboard")
    tool_text = json.dumps(loop.tools_for(controls), ensure_ascii=False, sort_keys=True)
    return {"hunt prompt": hunt, "goal": cfg.get("goal", ""), "brief file": brief,
            "controls": controls,
            "instructions": instructions, "tools": tool_text}


def _normalize(text):
    return re.sub(r"[\s_-]+", " ", text).casefold()


def _terms(path):
    terms = [line.strip() for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    return terms


def check(game, terms_file, run=None):
    if not Path(terms_file).is_file():
        raise FileNotFoundError(f"terms file not found: {terms_file}")
    terms = _terms(terms_file)
    if not terms:
        raise ValueError("terms file is empty")
    sections = build_text(game)
    chars = sum(len(text) for text in sections.values())
    for label, text in sections.items():
        normalized = _normalize(text)
        for term in terms:
            if _normalize(term) in normalized:
                print(f"FOUND {term!r} in {label}")
                return 1
    if run:
        run_path = Path(run)
        saved = []
        # Current runs save result.json and action logs, but not model request prompts.
        for path in run_path.rglob("*"):
            if path.is_file() and path.suffix.lower() in {".json", ".jsonl", ".txt"}:
                try:
                    value = path.read_text(encoding="utf-8")
                except (UnicodeError, OSError):
                    continue
                saved.append((str(path), value))
        if not saved:
            print("No saved text files found in run")
        for location, text in saved:
            chars += len(text)
            normalized = _normalize(text)
            for term in terms:
                if _normalize(term) in normalized:
                    print(f"FOUND {term!r} in {location}")
                    return 1
    print(f"Clean: {len(terms)} terms, {chars} characters searched")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Check hunt prompt text for terms from a text file. Console commands in a config's setup are not sent to the model and are not checked.")
    parser.add_argument("--game", required=True, help="game config name")
    parser.add_argument("--terms", required=True, help="external text file, one term per line")
    parser.add_argument("--run", help="also search saved text files in this run folder")
    args = parser.parse_args(argv)
    try:
        return check(args.game, args.terms, args.run)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
