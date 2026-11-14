"""One shared spending ledger for both trials. A hard cap in code, a cost line per call, never the key."""
import contextlib
import json
import os
import threading
import time
import uuid
from pathlib import Path

# Hard spend cap in code. The environment variable can only lower it, never raise it.
# The $150 credits had not landed, so his card pays meanwhile. Env can lower the cap, never raise it.
# Raised from $35 to $50 on 28 Oct 2026, his words: "bump play test agent's allowance to 50 and please have it get this right this time".
# Raised from $50 to $60 on 28 Oct 2026 evening, for the 12 expansion ideas, his words: "the agent can get a $10 dollar budget
# btw for testing regardless I think we will not keep the credits during testing phase sop no use saving them but we should
# still use them wisely".
# Raised from $60 to $80 on 29 Oct 2026 night, his words: "raise the cap by 20 for the night just in case". For the night; he decides in the morning whether it stays.
# Raised from $80 to $85 on 31 Oct 2026, his words: "alo increase the muse cap to $85".
# Raised from $85 to $145 on 1 Nov 2026, for 3 jobs on Meta's free credit, his words: "sure run all 3 I guess it does not hurt to try".
TOTAL_CAP_USD = 145.00
# The live demo's spend has its own cap, DEMO_CAP_USD = 20.00 in pt/demo.py (his words, 28 Oct 2026: "20 is fine").
# Rows tagged with this repo count only against that cap, never against TOTAL_CAP_USD. Worst case total: 145 + 20 = $165.
DEMO_REPO = "playtest-demo"


def capped(rows):
    """The rows TOTAL_CAP_USD covers: everything but the demo's own."""
    return [r for r in rows if r.get("repo") != DEMO_REPO]


def default_ledger():
    """PLAYTEST_LEDGER if set, else data/ledger.jsonl in this repo."""
    env = os.environ.get("PLAYTEST_LEDGER")
    return Path(env) if env else Path(__file__).resolve().parents[1] / "data" / "ledger.jsonl"
_EPS = 1e-9
LOCK_WAIT_S = 10.0       # how long to wait for another process that holds the ledger
LOCK_STALE_S = 30.0      # a lock older than this was left by a process that died


class CapReached(Exception):
    pass


def effective_cap() -> float:
    raw = os.environ.get("PLAYTEST_CAP_USD")
    if raw is None:
        return TOTAL_CAP_USD
    try:
        v = float(raw)
    except ValueError:
        return TOTAL_CAP_USD
    if v != v or v < 0:
        return TOTAL_CAP_USD
    return min(v, TOTAL_CAP_USD)


class Ledger:
    def __init__(self, path=None, repo=""):
        self.path = Path(path) if path else default_ledger()
        self.repo = repo
        self._lock = threading.Lock()

    def _rows(self):
        if not self.path.exists():
            return []
        rows = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                raise CapReached("the ledger file is damaged: refusing to spend until it is checked")
        return rows

    @staticmethod
    def _total(rows) -> float:
        reserved, settled = {}, {}
        for r in rows:
            if r.get("type") == "reserve":
                reserved[r["id"]] = float(r["usd"])
            elif r.get("type") == "settle":
                settled[r["id"]] = float(r["cost_usd"])
        return sum(settled.get(i, v) for i, v in reserved.items())

    def spent(self) -> float:
        with self._lock:
            return self._total(self._rows())

    @contextlib.contextmanager
    def _file_lock(self):
        """A lock file shared by every process, so two trial scripts can never both read the total and then both spend."""
        lock = self.path.with_name(self.path.name + ".lock")
        lock.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + LOCK_WAIT_S
        while True:
            try:
                fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
                break
            except (FileExistsError, PermissionError):
                # Windows answers PermissionError, not FileExistsError, while another holder's lock file is being deleted.
                if time.time() > deadline:
                    raise CapReached("the ledger is locked by another process: refusing to spend until it is free")
                try:
                    if time.time() - lock.stat().st_mtime > LOCK_STALE_S:
                        lock.unlink()
                        continue
                except OSError:
                    pass
                time.sleep(0.02)
        try:
            yield
        finally:
            try:
                lock.unlink()
            except OSError:
                pass

    def _append(self, row):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, sort_keys=True) + "\n")

    def cap(self):
        return effective_cap()

    def reserve(self, usd: float, label: str = "") -> str:
        with self._lock, self._file_lock():
            rows = self._rows()
            cap = self.cap()
            now = self._total(capped(rows))
            if now + usd > cap + _EPS:
                raise CapReached(f"cap ${cap:.2f} reached: spent ${now:.4f}, this call may cost up to ${usd:.4f}")
            rid = uuid.uuid4().hex[:12]
            self._append({"type": "reserve", "id": rid, "usd": round(usd, 6), "label": label, "repo": self.repo, "ts": time.time()})
            return rid

    def settle(self, rid: str, cost_usd: float, **fields) -> None:
        with self._lock, self._file_lock():
            self._append({"type": "settle", "id": rid, "cost_usd": round(cost_usd, 6), "repo": self.repo, "ts": time.time(), **fields})
