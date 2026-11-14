"""Capture a saved chess replay as a headless video and stills."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "games.cache" / "react-chess"
DIST = SOURCE / "dist"
MEMORY_LIMIT = 8 * 1024 ** 3
WAIT_LIMIT = 20 * 60
ACTION_DELAY_MS = 700


def free_memory():
    if os.name == "nt":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(status)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            raise OSError("Could not read free memory")
        return status.ullAvailPhys
    try:
        import psutil
    except ImportError as exc:
        raise RuntimeError("psutil is required to read free memory on this platform") from exc
    return psutil.virtual_memory().available


def prepare_build(fixed, temporary, *, build_runner=None):
    if fixed is None:
        return type("Build", (), {"source": SOURCE, "dist": DIST, "temporary": None})()
    with Path(fixed).open(encoding="utf-8") as handle:
        data = json.load(handle)
    attempts = data.get("attempts")
    if not isinstance(attempts, list) or not attempts or not isinstance(attempts[-1].get("edits"), dict):
        raise ValueError("Fix JSON must contain attempts with file edits")
    source = Path(temporary) / "source"
    shutil.copytree(SOURCE, source)
    from pt.fix_patch import apply_edits
    for name, edits in attempts[-1]["edits"].items():
        relative = Path(name)
        target = (source / relative).resolve()
        if relative.is_absolute() or ".." in relative.parts or not target.is_relative_to(source.resolve()) or not target.is_file():
            raise ValueError(f"Invalid edited source path: {name}")
        original = target.read_text(encoding="utf-8")
        target.write_text(apply_edits(original, edits), encoding="utf-8", newline="\n")
    dist = Path(temporary) / "dist"
    if build_runner:
        build_runner(source, dist)
    else:
        subprocess.run([sys.executable, str(ROOT / "tools" / "build_chess.py"), "--src", str(source), "--out", str(dist)],
                       cwd=ROOT, check=True)
    return type("Build", (), {"source": source, "dist": dist, "temporary": temporary})()


def _state(page):
    return page.evaluate("""() => ({board: Array.from(document.querySelectorAll('button.square'),
      s => { const m = (s.style.backgroundImage || s.getAttribute('style') || '').match(/Chess_([A-Za-z0-9]+)\\.svg/); return m ? m[1] : null; }),
      turn: document.querySelector('#player-turn-box')?.getAttribute('style') || null,
      status: document.querySelector('.game-status')?.textContent || ''})""")


def capture(run_dir, report, out, *, fixed=None, memory_reader=free_memory, sleep=time.sleep,
            browser_factory=None, server_factory=None, build_runner=None):
    run_dir, out = Path(run_dir).resolve(), Path(out).resolve()
    saved = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    reports = saved.get("reports", [])
    if type(report) is not int or not 0 <= report < len(reports):
        raise ValueError("report must be a saved report index")
    selected = reports[report]
    step = selected.get("step")
    actions = saved.get("actions_by_step")
    if type(step) is not int or not isinstance(actions, list) or not 0 <= step <= len(actions):
        raise ValueError("report step is outside actions_by_step")
    elapsed = 0
    while memory_reader() < MEMORY_LIMIT:
        if elapsed >= WAIT_LIMIT:
            print("Free memory stayed below 8 GB for 20 minutes")
            return 2
        print("Waiting for 8 GB free memory before chess capture")
        sleep(min(30, WAIT_LIMIT - elapsed))
        elapsed += min(30, WAIT_LIMIT - elapsed)

    out.mkdir(parents=True, exist_ok=True)
    capture_started = time.perf_counter()
    server = thread = browser = context = page = None
    temporary_context = tempfile.TemporaryDirectory(prefix="chess-capture-") if fixed else None
    try:
        build = prepare_build(fixed, temporary_context.name if temporary_context else None, build_runner=build_runner)
        class QuietHandler(SimpleHTTPRequestHandler):
            def log_message(self, fmt, *args): pass
        server = server_factory(build.dist) if server_factory else ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietHandler, directory=str(build.dist)))
        if hasattr(server, "serve_forever"):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/index.html"
        else:
            url = server
        if browser_factory:
            browser = browser_factory(headless=True, viewport={"width": 900, "height": 620},
                                      device_scale_factor=2, record_video_dir=str(out),
                                      record_video_size={"width": 900, "height": 620})
            page = browser
        else:
            from playwright.sync_api import sync_playwright
            playwright = sync_playwright().start()
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 900, "height": 620}, device_scale_factor=2,
                                          record_video_dir=str(out), record_video_size={"width": 900, "height": 620})
            page = context.new_page()
            page._capture_playwright = playwright
            cache = ROOT / "games.cache" / "chess-pieces"
            cache.mkdir(parents=True, exist_ok=True)
            def cache_piece(route):
                request_url = route.request.url
                path = cache / (hashlib.sha256(request_url.encode()).hexdigest() + ".svg")
                if path.is_file():
                    route.fulfill(status=200, content_type="image/svg+xml", body=path.read_bytes())
                else:
                    response = route.fetch()
                    body = response.body()
                    if response.ok:
                        path.write_bytes(body)
                    route.fulfill(response=response, body=body)
            page.route("**/*Chess_*.svg", cache_piece)
        page.goto(url)
        page.wait_for_function("document.querySelectorAll('button.square').length === 64")
        for index, group in enumerate(actions[:step], start=1):
            for action in group:
                if action.get("type") == "click":
                    page.mouse.click(action["x"], action["y"])
                elif action.get("type") == "wait":
                    page.wait_for_timeout(action.get("ms", 0))
                elif action.get("type") == "keypress":
                    for key in action.get("keys", []): page.keyboard.press(key)
                elif action.get("type") == "scroll":
                    page.mouse.wheel(action.get("x", 0), action.get("y", 0))
            page.wait_for_timeout(ACTION_DELAY_MS)
            page.screenshot(path=str(out / f"step-{index:04d}.png"))
            (out / f"step-{index:04d}.json").write_text(json.dumps(_state(page), indent=2), encoding="utf-8")
        capture_data = {"speed": 1, "build": "fixed" if fixed else str(DIST), "game_commit": _game_commit(),
                        "report_title": selected.get("title", ""), "report": report, "step": step,
                        "action_count": step, "action_delay_ms": ACTION_DELAY_MS,
                        "elapsed_seconds": round(step * ACTION_DELAY_MS / 1000, 3),
                        "capture_wall_seconds": round(time.perf_counter() - capture_started, 3)}
        (out / "capture.json").write_text(json.dumps(capture_data, indent=2), encoding="utf-8")
        return 0
    finally:
        if page is not None:
            try: page.close()
            except Exception: pass
        if context is not None:
            try: context.close()
            except Exception: pass
        if browser is not None:
            try: browser.close()
            except Exception: pass
        if page is not None and hasattr(page, "_capture_playwright"):
            page._capture_playwright.stop()
        if server is not None and hasattr(server, "shutdown"):
            server.shutdown()
            server.server_close()
        if thread is not None and thread.is_alive(): thread.join()
        if temporary_context is not None: temporary_context.cleanup()


def _game_commit():
    manifest = ROOT / "tools" / "games-manifest.json"
    try:
        games = json.loads(manifest.read_text(encoding="utf-8"))
        return next(game["commit"] for game in games if game["name"] == "react-chess")
    except (OSError, ValueError, KeyError, StopIteration):
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_folder", type=Path)
    parser.add_argument("--report", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fixed", type=Path)
    args = parser.parse_args(argv)
    try:
        return capture(args.run_folder, args.report, args.out, fixed=args.fixed)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
