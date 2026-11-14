"""Run the public benchmark through the normal playtest CLI."""
import argparse
import json
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "data" / "runs"


def main(argv=None):
    from pt import cli
    from bench import score

    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("game", choices=["holdout", "cave-courier"])
    parser.add_argument("--name", required=True)
    args, flags = parser.parse_known_args(argv)
    if Path(args.name).name != args.name or args.name in (".", ".."):
        parser.error("name must be a single folder name")
    if any(flag.split("=", 1)[0] in ("--game", "--bugs", "--clean") for flag in flags):
        parser.error("the benchmark sets --game, --bugs and --clean")
    hunt = ["hunt", args.name, "--game", args.game, "--bugs", "1,2,3,4,5", *flags]
    options = cli.parse(hunt)
    problem = cli.clean_problem(options)
    if problem:
        parser.error(problem)
    clean_name = args.name + "-clean"
    for name in (args.name, clean_name):
        if (RUNS / name).exists():
            parser.error("run folder already exists: " + str(RUNS / name))
    confirm_flags = ["--model", options.model, "--glimmer-url", options.glimmer_url,
                     "--reasoning", options.reasoning]
    for flag in ("offline", "allow_gpu"):
        if getattr(options, flag):
            confirm_flags.append("--" + flag.replace("_", "-"))
    commands = [hunt,
                ["confirm", str(RUNS / args.name), *confirm_flags],
                ["hunt", clean_name, "--game", args.game, "--bugs", "", "--clean", *flags],
                ["confirm", str(RUNS / clean_name), *confirm_flags]]
    for command in commands:
        print(shlex.join([sys.executable, "-m", "pt", *command]), flush=True)
        status = cli.main(command)
        if status:
            return status
        if command[0] == "hunt":
            result = RUNS / command[1] / "result.json"
            if result.is_file():
                stop = json.loads(result.read_text(encoding="utf-8")).get("stop", "")
                if stop.startswith("error:"):
                    print("Hunt failed: " + stop)
                    return 1
    scoring = [str(RUNS / args.name), "--clean", str(RUNS / clean_name)]
    print(shlex.join([sys.executable, "-m", "bench.score", *scoring]), flush=True)
    return score.main(scoring)


if __name__ == "__main__":
    sys.exit(main())
