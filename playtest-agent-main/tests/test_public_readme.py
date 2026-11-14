"""Every file and module the README tells a reader to use must be in the public copy."""
import re
from pathlib import Path

from tools import make_public

ROOT = Path(__file__).resolve().parents[1]


def readme_needs(text):
    """Files after `-r` and modules after `python -m` in the README's code blocks (installed packages are skipped)."""
    code = "\n".join(re.findall(r"```[^\n]*\n(.*?)```", text, flags=re.S))
    files = re.findall(r"-r\s+(\S+)", code)
    mods = [m for m in re.findall(r"python -m (\S+)", code) if m.split(".")[0] in {"pt", "tools", "trials", "pw", "metaclient"}]
    return files, mods


def module_file(mod):
    return mod.replace(".", "/") + ".py"


def test_readme_needs_are_found():
    files, mods = readme_needs("```\npip install -r requirements.txt\npython -m pt goal x\npython -m playwright install\n```")
    assert files == ["requirements.txt"] and mods == ["pt"]


def test_quick_start_works_in_every_shell_from_a_fresh_venv():
    """Judges run the repo from its setup steps (organizer answer, 28 Oct). Found that day in a fresh folder: the steps had
    no venv, and only the cmd form of the key line (`set`), which does nothing in PowerShell, bash or zsh."""
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    quick = text.split("## Quick start", 1)[1].split("\n## ", 1)[0]
    # Ubuntu 24.04, 28 Oct: "python" is missing (exit 127), venv needs python3-venv, Chromium needs its system libraries.
    for line in ("python -m venv .venv", r".venv\Scripts\activate", "python3 -m venv .venv", "source .venv/bin/activate",
                 "sudo apt install python3-venv", "python -m playwright install --with-deps chromium",
                 '$env:MODEL_API_KEY = "your key"', "set MODEL_API_KEY=your key", 'export MODEL_API_KEY="your key"'):
        assert line in quick, f"Quick start lacks: {line}"


def test_everything_the_readme_names_is_public():
    shipped = set(make_public.selected(ROOT, make_public.read_manifest(ROOT / "tools" / "public_manifest.txt")))
    files, mods = readme_needs((ROOT / "README.md").read_text(encoding="utf-8"))
    missing = [f for f in files if f not in shipped]
    missing += [m for m in mods if module_file(m) not in shipped and m.replace(".", "/") + "/__main__.py" not in shipped]
    assert not missing, f"the README names these, but the public copy leaves them out: {missing}"


def test_runtime_requirements_include_supported_versions():
    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
    assert "Pillow>=12.1" in requirements
    assert "psutil>=5.9; sys_platform != \"win32\"" in requirements


import json
import shlex
from pt.cli import parse


def public_files():
    return set(make_public.selected(ROOT, make_public.read_manifest(ROOT / "tools/public_manifest.txt")))


def shipped_path(path, shipped):
    return path.rstrip("/") in shipped or any(f.startswith(path.rstrip("/") + "/") for f in shipped)


def test_clone_once_in_public_text():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    prefix = "github.com/" + "Midknight56/"
    assert f"git clone https://{prefix}playtest-agent\ncd playtest-agent\n" in text
    assert text.count(prefix) == 1
    for f in public_files() - {"README.md"}:
        try:
            other = (ROOT / f).read_text(encoding="utf-8")
        except UnicodeError:
            continue
        assert prefix not in other, f


def test_readme_mods_and_commands():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    shipped = public_files()
    assert "has no game config or test mod" not in text
    for path in ("mods/pt_input", "mods/pt_fix", "games/sts2-example.json", "games/sts2.fix.example.json", "tools/build_sts2_mod.py", "tools/build_sts2_fix.py"):
        assert path in text and shipped_path(path, shipped), path
    assert "trials.judge_compare" not in text
    quick = text.split("## Quick start", 1)[1].split("\n## ", 1)[0]
    assert "5 planted bugs" in quick and "--clean" in quick
    assert "## More commands" in text
    for block in re.findall(r"```[^\n]*\n(.*?)```", text, re.S):
        for line in block.splitlines():
            if line.startswith("python -m pt "):
                parse(shlex.split(line)[3:])
    commands_table = text.split("## More commands", 1)[1].split("\n## ", 1)[0]
    for command in re.findall(r"`(python -m pt [^`]+)`", commands_table):
        for part in re.split(r"\s+then\s+", command):
            parse(shlex.split(part)[3:])


def test_private_server_and_public_paths():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    private = text.split("## Private mode", 1)[1].split("\n## ", 1)[0]
    assert "llama-server -m Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf --mmproj mmproj-Muse-Glimmer-30B-Q4_K_M.gguf -ngl 40 -c 16384 -np 1 -t 16 --host 127.0.0.1 --port 8090" in private
    for path in re.findall(r"(?<!`)`([^`\n]+)`(?!`)", text):
        if path.startswith(("samples/", "docs/", "bench/", "games/", "mods/", "tools/")) and "*" not in path:
            assert shipped_path(path, public_files()), path


def test_bench_and_receipts_ship():
    required = ["bench/run.py", "bench/score.py", "bench/README.md", "bench/holdout/SEALED-bugs.json", "bench/holdout/AUTHOR.md", "bench/holdout/PROMPT-FREEZE.json", "bench/holdout/grades/ho1.json", "bench/cave-courier/grades/cc1.json", "games/holdout.json", "tests/test_i4_bench.py", "tests/test_g3_coverage.py", "tests/test_prompt_freeze.py", "tools/prompt_freeze.py", "metaclient/fireworks.py", "trials/fireworks_judge.py", "tests/test_fireworks.py", "docs/receipts/judge-glimmer.json"]
    receipts = list(ROOT.glob("docs/receipts/spark-open-judge-f1-*.json"))
    assert len(receipts) == 3
    required += [p.relative_to(ROOT).as_posix() for p in receipts]
    assert set(required) <= public_files()
    assert not any("__pycache__" in p for p in public_files())
    for path in re.findall(r"`(bench/[^`]+)`", (ROOT / "docs/RESULTS.md").read_text(encoding="utf-8")):
        assert shipped_path(path, public_files()), path


def test_web_game_rows_match_saved_results():
    for doc in ("README.md", "docs/RESULTS.md"):
        text = (ROOT / doc).read_text(encoding="utf-8")
        row = next(line for line in text.splitlines() if line.startswith("| Four public web games,"))
        for game in ("2048", "hextris", "tetris", "breakout"):
            data = json.loads((ROOT / f"docs/receipts/runs/i5-{game}/result.json").read_text())
            assert f"{game.capitalize() if game != '2048' else game}: {data['steps']} steps, ${data['cost_usd']:.2f}." in row
            assert data["won"] is True and len(data["reports"]) == 0
        assert "All won; 0 reports" in row


def test_spark_open_numbers_match_receipt():
    stats = json.loads((ROOT / "docs/receipts/spark-open-judge-f1-low.json").read_text())["summary"]["all"]
    assert {k: stats[k] for k in ("agree", "total", "open_right", "spark_right", "misses", "false_alarms")} == dict(agree=48, total=49, open_right=44, spark_right=45, misses=1, false_alarms=4)
    for doc in ("README.md", "docs/RESULTS.md"):
        text = (ROOT / doc).read_text(encoding="utf-8").split("Muse Spark Open as the judge", 1)[1]
        for phrase in ("49 saved cases", "48", "44 right", "45", "1 miss and 4 false alarms", "24 of 116"):
            assert phrase in text


def test_more_commands_requirements():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    deathmap = next(line for line in text.splitlines() if "| `python -m pt deathmap " in line)
    assert "python -m pt deathmap data/runs/first-run --ground-y 250" in deathmap
    assert "250 is Cave Courier's ground line" in deathmap
    fix = next(line for line in text.splitlines() if "| `python -m pt fix-any " in line)
    assert "It needs a report that passed `pt confirm` or `pt replay-check` and has no saved fix yet." in fix
