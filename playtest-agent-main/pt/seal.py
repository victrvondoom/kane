"""Create and check a content manifest for a run's review evidence."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def manifest(folder):
    folder = Path(folder)
    paths = {"result.json", "confirm.json"}
    paths.update(p.name for p in folder.glob("strip_*.jpg") if p.is_file())
    paths.update(p.name for p in folder.glob("s*.jpg") if p.is_file())
    for pattern in ("fix-any-*.json", "fix-any-*.public.json", "fix-any-*.diff", "replay-reads.json"):
        paths.update(p.name for p in folder.glob(pattern) if p.is_file())
    for sub in (folder / "frames", folder / "replay-check"):
        if sub.is_dir():
            paths.update(p.relative_to(folder).as_posix() for p in sub.rglob("*") if p.is_file())
    paths.update(p.relative_to(folder).as_posix() for p in folder.glob("trace_*") if p.is_dir()
                 for p in p.rglob("*") if p.is_file())
    files = {name: _sha(folder / name) for name in sorted(paths)}
    result_path = folder / "result.json"
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        result = {}
    game_id = result.get("game_id")
    config_path = ROOT / "games" / (str(game_id) + ".json") if game_id else None
    config_hash = _sha(config_path) if config_path else None
    try:
        config = json.loads(config_path.read_text(encoding="utf-8")) if config_path and config_path.is_file() else {}
    except (OSError, ValueError):
        config = {}
    url = config.get("url")
    local_hash = None
    if isinstance(url, str):
        candidate = (ROOT / url).resolve()
        if candidate.is_relative_to(ROOT.resolve()):
            local_hash = _sha(candidate)
    return {"files": files, "build": {"game_id": game_id, "game_config_sha256": config_hash,
                                        "game_file_sha256": local_hash}}


def digest(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def check(folder, sealed):
    current = manifest(folder)
    changed = []
    for key in sorted(set(current["files"]) | set(sealed.get("files", {}))):
        if current["files"].get(key) != sealed.get("files", {}).get(key):
            changed.append(key)
    for key in sorted(set(current["build"]) | set(sealed.get("build", {}))):
        if current["build"].get(key) != sealed.get("build", {}).get(key):
            changed.append("build." + key)
    return changed
