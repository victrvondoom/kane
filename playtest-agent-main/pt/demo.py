"""The live demo: one page, one bug hunt at a time, with every money guard on the server (docs/LIVE-DEMO.md).
Run: DEMO_PASSCODE=<code> python -m pt.demo --port 8765    (it listens on 127.0.0.1 only)"""
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from metaclient.ledger import _EPS, DEMO_REPO, CapReached, Ledger, default_ledger
from pt.demo_data import load, run_view
from pt.demo_page import PAGE

ROOT = Path(__file__).resolve().parents[1]
# The owner's pick, 28 Oct 2026: "it prob does not cover judging, I do not mind paying for it, 20 is fine".
# 20 runs at RUN_CAP_USD each. Its own room: demo spend counts only here, and other spend never touches it.
# Worst case for the whole ledger: TOTAL_CAP_USD $85 + DEMO_CAP_USD $20 = $105.
DEMO_CAP_USD = 20.00
# c10 cost $0.80657 for 41 steps; 60 step hunts cost $0.98706 and $0.99926 (docs/RESULTS.md). A 30 step hunt plus its check fits.
RUN_CAP_USD = 1.00
PLAY_USD = 0.85          # the play stops here; the rest of the run cap is for the judge calls (Spark, about $0.01 each)
DEMO_STEPS = 30
DEMO_SECONDS = 420
DEMO_GAME = "cave-courier-art"     # his pick, 28 Oct: the art build (h12 found 5 of its 5 planted bugs)
DEMO_BUGS = "1,2,3,4,5"
RUNS_PER_IP = 2          # a day: at most 2 x $1.00 from one address
BAD_CODES_PER_IP = 10    # an hour: stops a guessing script
DAY, HOUR = 86400, 3600
REPLAYS = ("h12", "t-doom4", "cl21")   # h12: a hunt on the art build, 6 reports, 6 confirmed
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")
MEMINFO = Path("/proc/meminfo")
DROPLET_MIN_FREE_GB = 0.6    # a 2 GiB droplet: Chromium and the server need about this much before a run starts (my pick, not measured there)

OFF = "The demo is switched off."
NO_CODE = "The demo has no passcode set, so it is closed."
WRONG = "Wrong passcode."
GUESSING = "Too many wrong passcodes from this address. Try again in an hour."
BUSY = "A run is going now. Watch it, or try again when it ends."
USED = f"This address has used its {RUNS_PER_IP} runs for today."
NO_LEDGER = "The spend ledger cannot be read, so no run starts."
SPENT = "The demo budget is spent. The recorded run is shown instead."
NO_BOOK = "The address book cannot be read, so no run starts."
NO_KEY = "This demo has no API key, so only recorded runs are shown."


class DemoLedger(Ledger):
    """The shared file with the demo's own cap and this run's cap, checked under the ledger's file lock in the step that writes the reserve."""

    def __init__(self, path, run_cap=RUN_CAP_USD, demo_cap=DEMO_CAP_USD):
        super().__init__(path, repo=DEMO_REPO)
        self.run_cap, self.demo_cap, self.ids = run_cap, demo_cap, set()

    def run_spent(self):
        return self._total([r for r in self._rows() if r.get("id") in self.ids])

    def reserve(self, usd, label=""):
        with self._lock, self._file_lock():
            rows = self._rows()
            demo = self._total([r for r in rows if r.get("repo") == DEMO_REPO])
            run = self._total([r for r in rows if r.get("id") in self.ids])
            if demo + usd > self.demo_cap + _EPS:
                raise CapReached(f"demo cap ${self.demo_cap:.2f} reached: the demo spent ${demo:.4f}")
            if run + usd > self.run_cap + _EPS:
                raise CapReached(f"run cap ${self.run_cap:.2f} reached: this run spent ${run:.4f}")
            rid = uuid.uuid4().hex[:12]
            self._append({"type": "reserve", "id": rid, "usd": round(usd, 6), "label": label, "repo": self.repo, "ts": time.time()})
            self.ids.add(rid)
            return rid


def room(path, demo_cap=DEMO_CAP_USD):
    """Money left for the demo under its own cap. A missing or damaged ledger raises."""
    path = Path(path)
    if not path.is_file():
        raise CapReached(f"no ledger file at {path}")
    rows = Ledger(path)._rows()          # a damaged line raises CapReached
    return demo_cap - Ledger._total([r for r in rows if r.get("repo") == DEMO_REPO])


def client_ip(handler, trust_cf=None):
    """The connection's address. A Cloudflare header is believed only behind our own tunnel (DEMO_TRUST_CF=1): anyone can send that header.
    Behind Caddy on the same machine (DEMO_TRUST_PROXY=1), the last X-Forwarded-For entry is the one Caddy wrote; Caddy drops a client's own."""
    trust_cf = os.environ.get("DEMO_TRUST_CF") == "1" if trust_cf is None else trust_cf
    peer = handler.client_address[0]
    header = handler.headers.get("CF-Connecting-IP") if trust_cf else None
    if not header and os.environ.get("DEMO_TRUST_PROXY") == "1" and peer in ("127.0.0.1", "::1"):
        forwarded = [p.strip() for p in (handler.headers.get("X-Forwarded-For") or "").split(",") if p.strip()]
        header = forwarded[-1] if forwarded else None
    return (header or peer).strip()


def droplet_problems():
    """The host guard on a Linux droplet: only free memory (this PC's guards read a GPU and windows a droplet does not have)."""
    try:
        line = next(x for x in MEMINFO.read_text(encoding="utf-8").splitlines() if x.startswith("MemAvailable:"))
        free = int(line.split()[1]) / 2 ** 20
    except (OSError, StopIteration, ValueError, IndexError):
        return ["could not read free memory"]
    return [f"free memory is {free:.1f} GB (limit {DROPLET_MIN_FREE_GB} GB)"] if free < DROPLET_MIN_FREE_GB else []


def export_rows(path):
    """The demo's own rows of a ledger, to seed the droplet's ledger or to bring its spend back to this PC."""
    return [r for r in Ledger(path)._rows() if r.get("repo") == DEMO_REPO]


def import_rows(path, rows):
    """Add the demo rows a ledger does not have yet. Refuses any row of another repo. Returns how many were added."""
    if any(r.get("repo") != DEMO_REPO for r in rows):
        raise ValueError("only playtest-demo rows can be imported")
    led = Ledger(path, repo=DEMO_REPO)
    with led._lock, led._file_lock():
        have = {(r.get("type"), r.get("id")) for r in led._rows()}
        new = [r for r in rows if (r.get("type"), r.get("id")) not in have]
        for r in new:
            led._append(r)
    return len(new)


class Demo:
    def __init__(self, ledger_path, passcode, client_factory, driver_factory, host_problems=lambda: [], data=None,
                 kill_file=None, replay_root=None, replays=REPLAYS, clock=time.time, must_stop=lambda: False,
                 steps=DEMO_STEPS, pc_lock=None, has_key=True, repo=None):
        self.ledger_path = Path(ledger_path)
        self.passcode = passcode or ""
        self.client_factory, self.driver_factory = client_factory, driver_factory
        self.host_problems, self.must_stop, self.clock, self.steps = host_problems, must_stop, clock, steps
        self.data = Path(data) if data else ROOT / "data" / "demo"
        self.kill_file = Path(kill_file) if kill_file else self.data / "STOP"
        self.book_file = self.data / "addresses.json"
        self.runs_dir = self.data / "runs"
        self.replay_root = Path(replay_root) if replay_root else ROOT / "data" / "runs"
        self.replays = [r for r in replays if (self.replay_root / r / "result.json").is_file()]
        self.pc_lock = pc_lock          # (take, release) of this PC's one-run lock, or None
        self.lock = threading.Lock()
        self.thread = None
        self.live = {"state": "idle"}
        self.sink = {}
        self.has_key, self.repo = has_key, repo
        self.check_rows = []
        self.started = None

    # ---- the guards ----------------------------------------------------------
    def _book(self):
        if not self.book_file.exists():
            return {"salt": secrets.token_hex(16), "runs": {}, "bad": {}}
        return json.loads(self.book_file.read_text(encoding="utf-8"))

    def _save_book(self, book):
        self.book_file.parent.mkdir(parents=True, exist_ok=True)
        self.book_file.write_text(json.dumps(book), encoding="utf-8")

    def busy(self):
        return self.thread is not None and self.thread.is_alive()

    def admit(self, code, ip):
        """(True, run name) or (False, the reason in one line). Every check is here, on the server."""
        with self.lock:
            if not self.has_key:
                return False, NO_KEY
            if self.kill_file.exists():
                return False, OFF
            if not self.passcode:
                return False, NO_CODE
            try:
                book = self._book()
            except (OSError, ValueError):
                return False, NO_BOOK
            now = self.clock()
            key = hashlib.sha256((book["salt"] + "|" + ip).encode()).hexdigest()[:20]     # kept as a hash, never the plain address
            bad = [t for t in book["bad"].get(key, []) if now - t < HOUR]
            if len(bad) >= BAD_CODES_PER_IP:
                return False, GUESSING
            if not hmac.compare_digest(str(code or "").encode(), self.passcode.encode()):
                book["bad"][key] = bad + [now]
                self._save_book(book)
                return False, WRONG
            if self.busy():
                return False, BUSY
            runs = [t for t in book["runs"].get(key, []) if now - t < DAY]
            if len(runs) >= RUNS_PER_IP:
                return False, USED
            try:
                left = room(self.ledger_path)
            except (CapReached, OSError):
                return False, NO_LEDGER
            if left < RUN_CAP_USD - _EPS:
                return False, SPENT
            host = self.host_problems()
            if host:
                return False, "The host is busy: " + "; ".join(host)
            book["runs"][key] = runs + [now]
            self._save_book(book)
            name = time.strftime("d%Y%m%d-%H%M%S", time.gmtime(now)) + "-" + secrets.token_hex(2)
            self.sink = {}
            self.check_rows = []
            self.started = self.clock()
            self.live = {"state": "running", "run": name, "step": 0, "cost_usd": 0.0, "reports": [], "checks": [], "reason": ""}
            self.thread = threading.Thread(target=self._work, args=(name,), daemon=True)
            self.thread.start()
            return True, name

    def _should_stop(self):
        if self.kill_file.exists():
            return "kill switch"
        return "memory" if self.must_stop() else None

    # ---- one run -------------------------------------------------------------
    def _work(self, name):
        from pt import loop as Lp
        from pt.cli import hunt_text
        from trials.common import save_json

        folder = self.runs_dir / name
        folder.mkdir(parents=True, exist_ok=True)
        led = DemoLedger(self.ledger_path)
        driver = None
        if self.pc_lock:
            self.pc_lock[0]()
        try:
            client = self.client_factory(led)
            driver = self.driver_factory(DEMO_BUGS)
            reload = callable(getattr(driver, "reload", None))

            def on_step(i, shot):
                (folder / f"s{i:03d}.jpg").write_bytes(shot)
                self.live.update(step=i, shot=f"s{i:03d}.jpg")

            try:
                res = Lp.run_episode(client, driver, hunt_text(self.steps, reload), max_steps=self.steps, max_seconds=DEMO_SECONDS,
                                     max_usd=PLAY_USD, on_step=on_step, label=f"demo:{name}", sink=self.sink,
                                     should_stop=self._should_stop, reload=reload, nudges=2, look_plan=True)
            except CapReached as e:
                res = {**self.sink, "stop": "run cap", "error": str(e)[:300], "final_text": "", "seconds": 0}
            except Exception as e:          # keep what happened so far, and say so
                res = {**self.sink, "stop": "error:" + type(e).__name__, "error": str(e)[:300], "final_text": "", "seconds": 0}
            res.update({"kind": "hunt", "bugs_on": DEMO_BUGS, "game": getattr(driver, "name", DEMO_GAME), "game_id": DEMO_GAME,
                        "won": bool(getattr(driver, "won", lambda: False)()), "bug_hits": getattr(driver, "bug_hits", lambda: [])(),
                        "settings": {"model": "wonder", "effort": "low", "look_plan": True, "demo": True}})
            res.setdefault("reports", [])
            res.setdefault("actions_by_step", [])
            save_json(folder / "result.json", res)
            self.live.update(state="checking", reports=[r.get("title", "") for r in res["reports"]], stop=res.get("stop"))
            driver.close()
            driver = None
            if res["reports"] and res.get("stop") != "kill switch" and not self.kill_file.exists():
                from pt import confirm
                try:
                    rows = confirm.confirm_run(folder, client, driver_cls=lambda bugs="": self.driver_factory(bugs),
                                               on_check=lambda row: self.check_rows.append(dict(row)))
                    self.live["checks"] = [{"title": r["title"], "confirmed": r["confirmed"], "reproducible": r["reproducible"],
                                            "evidence": r["evidence"][:300]} for r in rows]
                except Exception as e:
                    self.live["reason"] = "The check stopped: " + (str(e) if isinstance(e, CapReached) else type(e).__name__)
            try:
                from pt import report
                report.write(folder)
                self.live["report"] = "report.html"
            except Exception as e:
                self.live["reason"] = (self.live.get("reason", "") + " The report failed: " + type(e).__name__).strip()
        except Exception as e:
            self.live["reason"] = "The run failed: " + type(e).__name__
        finally:
            if driver is not None:
                driver.close()
            if self.pc_lock:
                self.pc_lock[1]()
            try:
                self.live["cost_usd"] = round(led.run_spent(), 5)
            except CapReached:
                pass
            self.live["state"] = "done"
            if self.started is not None:
                self.live["seconds"] = round(self.clock() - self.started, 1)

    # ---- what the page reads -------------------------------------------------
    def status(self):
        s = dict(self.live)
        log = self.sink.get("log") or []
        if s.get("state") == "running":
            s["cost_usd"] = self.sink.get("cost_usd", 0.0)
            s["reports"] = [r.get("title", "") for r in self.sink.get("reports", [])]
            calls = log[-1]["calls"] if log else []
            s["look"] = next((c["args"].get("look", "") for c in calls if c["name"] == "act"), "")
        s["replays"] = self.replays
        try:
            s["room_usd"] = round(room(self.ledger_path), 2)
        except (CapReached, OSError):
            s["room_usd"] = None
        s["switched_off"] = self.kill_file.exists()
        folder = self.runs_dir / s.get("run", "")
        result = load(folder / "result.json", self.sink)
        if s.get("state") == "running":
            result = dict(self.sink)
        else:
            result = dict(result)
        result["cost_usd"] = s.get("cost_usd", result.get("cost_usd", 0))
        result["seconds"] = s.get("seconds", round(self.clock() - self.started, 1) if self.started is not None else 0)
        result.setdefault("steps", s.get("step", 0))
        view = run_view(folder, result, f"/run/{s.get('run', '')}/", checks=self.check_rows, repo=self.repo)
        if not s.get("run"):
            view["links"] = {}
        s.update(view)
        return s

    def replay(self, name):
        """The frames of a recorded run, each with its LOOK line."""
        if name not in self.replays:
            return None
        folder = self.replay_root / name
        res = json.loads((folder / "result.json").read_text(encoding="utf-8"))
        looks = {}
        for row in res.get("log", []):
            act = next((c["args"] for c in row.get("calls", []) if c.get("name") == "act"), {})
            keys = [k for a in act.get("actions", []) for k in a.get("keys", [])]
            looks[row.get("step")] = act.get("look") or ("Keys: " + " ".join(keys) if keys else "")
        for rep in res.get("reports", []):        # a run with no LOOK lines shows its bug reports where they were filed
            looks[rep.get("step")] = "Bug report: " + rep.get("title", "")
        try:
            confirmed = sum(1 for r in json.loads((folder / "confirm.json").read_text(encoding="utf-8")) if r.get("confirmed"))
        except (OSError, ValueError):
            confirmed = None
        frames = sorted(p.name for p in folder.glob("s[0-9][0-9][0-9].jpg"))
        return {"run": name, "game": res.get("game", ""), "game_id": res.get("game_id", ""),
                "cost_usd": res.get("cost_usd"), "reports": len(res.get("reports", [])), "confirmed": confirmed,
                "frames": [{"file": f, "look": looks.get(int(f[1:4]), "")} for f in frames],
                **run_view(folder, res, f"/replay-file/{name}/", repo=self.repo)}

    def file(self, kind, name, filename):
        """A file of a recorded run or of a demo run. Names are checked, so no path can leave those folders."""
        if not (SAFE_NAME.match(name or "") and SAFE_NAME.match(filename or "")) or ".." in name or ".." in filename:
            return None
        if kind == "replay" and name in self.replays:
            path = self.replay_root / name / filename
        elif kind == "run" and name == self.live.get("run"):
            path = self.runs_dir / name / filename
        else:
            return None
        return path if path.is_file() and path.suffix in (".jpg", ".png", ".html") else None


def handler_for(demo):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, kind="application/json"):
            data = body if isinstance(body, bytes) else (json.dumps(body) if kind == "application/json" else body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            parts = [p for p in self.path.split("?")[0].split("/") if p]
            if not parts:
                return self._send(200, PAGE, "text/html; charset=utf-8")
            if parts == ["status"]:
                return self._send(200, demo.status())
            if len(parts) == 2 and parts[0] == "replay":
                r = demo.replay(parts[1])
                return self._send(200, r) if r else self._send(404, {"reason": "no such replay"})
            if len(parts) == 3 and parts[0] in ("replay-file", "run"):
                path = demo.file("replay" if parts[0] == "replay-file" else "run", parts[1], parts[2])
                if path:
                    kind = {".jpg": "image/jpeg", ".png": "image/png", ".html": "text/html; charset=utf-8"}[path.suffix]
                    return self._send(200, path.read_bytes(), kind)
            return self._send(404, {"reason": "not found"})

        def do_POST(self):
            if self.path.split("?")[0] != "/run":
                return self._send(404, {"reason": "not found"})
            try:
                n = min(int(self.headers.get("Content-Length") or 0), 4096)
                code = json.loads(self.rfile.read(n) or b"{}").get("code", "")
            except (ValueError, AttributeError):
                code = ""
            ok, said = demo.admit(code, client_ip(self))
            return self._send(200 if ok else 403, {"ok": ok, "run": said} if ok else {"ok": False, "reason": said})
    return H


class Server(ThreadingHTTPServer):
    """Never shares its port. On 28 Oct another program bound 127.0.0.1:8765 while the demo held it, because Python's HTTP
    server asks for address reuse, which on Windows lets two programs listen on one port."""
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def serve(demo, port, host="127.0.0.1"):
    server = Server((host, port), handler_for(demo))
    server.daemon_threads = True
    return server


def build(env, key):
    """The demo as it runs for real. On this PC its host guards are the PC's own; on a droplet (DEMO_PC_GUARDS=0) only free memory."""
    from pt import guard
    from metaclient.client import MetaClient

    def make_driver(bugs=""):
        from pt import adapter
        return adapter.make(DEMO_GAME, bugs=bugs)

    ledger = Path(env["PLAYTEST_LEDGER"]) if env.get("PLAYTEST_LEDGER") else default_ledger()
    replay_root = env.get("DEMO_REPLAY_ROOT") or None
    if env.get("DEMO_PC_GUARDS", "1") == "0":
        return Demo(ledger, env.get("DEMO_PASSCODE", ""), lambda led: MetaClient(key, led), make_driver, host_problems=droplet_problems,
                    must_stop=lambda: bool(droplet_problems()), replay_root=replay_root, data=env.get("DEMO_DATA") or None,
                    has_key=bool(key), repo=env.get("DEMO_REPO_URL", ""))
    return Demo(ledger, env.get("DEMO_PASSCODE", ""), lambda led: MetaClient(key, led), make_driver, host_problems=guard.problems,
                must_stop=lambda: guard.must_stop(guard.free_gb()), pc_lock=(guard.take_lock, guard.release_lock), replay_root=replay_root,
                has_key=bool(key), repo=env.get("DEMO_REPO_URL", ""))


def main(argv=None):
    from pt import env as settings
    settings.load_local_env()
    p = argparse.ArgumentParser(prog="pt.demo")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--export-ledger", metavar="OUT", help="write the demo's own ledger rows to OUT (JSON lines) and stop")
    p.add_argument("--import-ledger", metavar="IN", help="add the demo rows in IN that the ledger does not have yet, and stop")
    a = p.parse_args(argv)
    if a.export_ledger or a.import_ledger:
        path = Path(os.environ["PLAYTEST_LEDGER"]) if os.environ.get("PLAYTEST_LEDGER") else default_ledger()
        if a.export_ledger:
            rows = export_rows(path)
            Path(a.export_ledger).write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows), encoding="utf-8")
            print(f"{len(rows)} demo rows written; demo room ${room(path):.5f}")
        else:
            rows = [json.loads(x) for x in Path(a.import_ledger).read_text(encoding="utf-8").splitlines() if x.strip()]
            print(f"{import_rows(path, rows)} rows added; demo room ${room(path):.5f}")
        return
    key = settings.api_key()
    demo = build(os.environ, key)
    server = serve(demo, a.port)
    try:
        budget = f"${room(demo.ledger_path):.2f}"
    except (CapReached, OSError):
        budget = "unavailable"
    mode = "live enabled" if key else "replay only"
    print(f"demo on http://127.0.0.1:{a.port}  {mode}  passcode {'set' if demo.passcode else 'NOT SET: every run is refused'}  room {budget}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
