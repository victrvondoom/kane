import subprocess
import sys


def test_old_python_gets_clear_message():
    result = subprocess.run(
        [sys.executable, "-c", "from pt.python_version import require_supported; require_supported((3, 9, 6))"],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "Python 3.12 or newer is needed; this is 3.9.6." in result.stderr
    assert "brew install python@3.12, then python3.12 -m venv .venv" in result.stderr


def test_all_public_entrypoints_check_version_first():
    script = r'''
import runpy, sys
sys.version_info = (3, 9, 6)
runpy.run_path(sys.argv[1], run_name="__main__")
'''
    for path in ("pt/__main__.py", "tools/public_check.py", "tools/make_public.py",
                 "tools/adapter_smoke.py", "tools/doom_smoke.py", "tools/fetch_games.py"):
        result = subprocess.run([sys.executable, "-c", script, path], capture_output=True, text=True)
        assert result.returncode != 0, path
        assert "Python 3.12 or newer is needed; this is 3.9.6." in result.stderr, path


def test_supported_python_passes():
    script = "from pt.python_version import require_supported; require_supported((3, 12, 0))"
    subprocess.run([sys.executable, "-c", script], check=True)
