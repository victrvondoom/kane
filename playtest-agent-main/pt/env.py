"""Machine specific settings: a git-ignored local.env file (KEY=VALUE per line) fills in missing environment values.
The API key comes from MODEL_API_KEY or from the file named by PLAYTEST_KEY_FILE (first line only)."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_local_env(path=None):
    p = Path(path) if path else ROOT / "local.env"
    try:
        lines = p.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def api_key():
    key = os.environ.get("MODEL_API_KEY", "").strip()
    if key:
        return key
    f = os.environ.get("PLAYTEST_KEY_FILE", "").strip()
    if f:
        try:
            lines = Path(f).read_text(encoding="utf-8-sig").splitlines()
            return lines[0].strip() if lines else ""
        except OSError:
            return ""
    return ""


def require_api_key():
    """Stop a paid command before it can create output or reserve spend."""
    if not api_key():
        print("no API key: set MODEL_API_KEY (or PLAYTEST_KEY_FILE). Nothing was spent.", file=sys.stderr)
        raise SystemExit(2)
