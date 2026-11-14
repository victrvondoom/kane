"""Shared helpers for the scripts: the client and the receipts folder."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from metaclient.client import MetaClient            # noqa: E402
from metaclient.ledger import Ledger                # noqa: E402
from pt.env import api_key, load_local_env          # noqa: E402


def load_client(repo: str) -> MetaClient:
    """The key comes from MODEL_API_KEY or the file named in PLAYTEST_KEY_FILE (local.env). It is never printed or written anywhere."""
    load_local_env()
    key = api_key()
    if not key:
        sys.exit("no API key: set MODEL_API_KEY, or PLAYTEST_KEY_FILE in local.env")
    led = Ledger(repo=repo)
    print(f"ledger: {led.path} (spent ${led.spent():.2f})", file=sys.stderr)
    return MetaClient(key, led)


def save_json(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
