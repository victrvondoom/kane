import importlib.util
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_real_doom_engine_tests_skip_by_default():
    env = os.environ.copy()
    env.pop("PT_DOOM_ENGINE", None)
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-rs", "tests/test_doom_engine.py"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if importlib.util.find_spec("vizdoom") is None:
        assert result.returncode in (0, 5), result.stdout + result.stderr
        assert "skipped" in result.stdout.lower(), result.stdout
    else:
        assert result.returncode == 0, result.stdout + result.stderr
        assert "ssssss" in result.stdout and "PT_DOOM_ENGINE=1" in result.stdout, result.stdout
