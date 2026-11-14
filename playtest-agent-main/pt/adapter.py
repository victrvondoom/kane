"""The game hook. A web game is a JSON config; any other game is a small subclass of Adapter.
The agent loop, the replay and the judge only call these methods, so a second game never touches them."""
import json
import subprocess
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import url2pathname

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_KEYS = {"space": "Space", " ": "Space", "left": "ArrowLeft", "right": "ArrowRight", "up": "ArrowUp", "down": "ArrowDown", "enter": "Enter", "esc": "Escape"}


class Adapter:
    """What a game must give the harness. Only screenshot, execute and close are required."""
    name = "game"
    controls = ""          # one or two lines for the agent: which keys do what
    goal = ""              # the default goal

    def screenshot(self):
        raise NotImplementedError

    def execute(self, actions):
        raise NotImplementedError

    def close(self):
        raise NotImplementedError

    def state(self):       # optional: a dict the game exposes (coins, score, position)
        from pt.sam_sensor import position
        return position(self)

    def won(self):         # optional: True when the goal is reached (only used to stop a goal run early and to grade it)
        return None

    def bug_hits(self):    # optional: a test game can say which planted bugs ran (grading only, never shown to the agent)
        return None

    def fresh(self):       # a clean copy of the game for a replay
        raise NotImplementedError


def validate(cfg):
    errs = []
    every = cfg.get("sam_every", 1)
    if type(every) is not int or every < 1:
        errs.append("sam_every must be an integer of at least 1")
    if "sam_player" in cfg and (not isinstance(cfg["sam_player"], str) or not cfg["sam_player"].strip()):
        errs.append("sam_player must be a noun phrase")
    if cfg.get("type") not in ("web", "android", "doom", "pcgame"):
        errs.append("type must be 'web', 'android', 'doom' or 'pcgame'")
    if not cfg.get("name"):
        errs.append("name is missing")
    if cfg.get("type") == "pcgame":
        for field in ("exe", "run_root", "side_display"):
            if not cfg.get(field):
                errs.append(f"{field} is missing")
    elif cfg.get("type") == "android":
        if not cfg.get("package"):
            errs.append("package is missing")
    elif cfg.get("type") == "doom":
        if not cfg.get("scenario"):
            errs.append("scenario is missing")
    elif not cfg.get("url") and not (cfg.get("serve") or {}).get("dir"):
        errs.append("url is missing (or give serve.dir)")
    return errs


def load_config(path):
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    errs = validate(cfg)
    if errs:
        raise ValueError(f"{path}: " + "; ".join(errs))
    return cfg


def build_url(cfg, **fmt):
    url = cfg["url"]
    if "://" not in url:
        url = (ROOT / url).resolve().as_uri()
    q = {k: v.format(**fmt) for k, v in (cfg.get("url_query") or {}).items()}
    q = {k: v for k, v in q.items() if v != ""}
    return url + ("?" + urlencode(q) if q else "")


class _Served:
    def __init__(self, server, thread, url):
        self.server, self.thread, self.url = server, thread, url

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def serve_dir(folder, port=0):
    """Serve a built web game from a folder, on 127.0.0.1 only. port 0 picks a free one."""
    import functools
    import http.server
    import threading

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=str(folder)))
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return _Served(srv, t, f"http://127.0.0.1:{srv.server_address[1]}/")


# A game on a locked clock runs a frame only when the harness asks. Two replays of the same moves then match exactly.
FRAME_LOCK_JS = """(() => {
  const queue = []; let now = 0;
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  window.__ptStep = (n) => { for (let i = 0; i < n; i++) { now += 1000 / 60; for (const cb of queue.splice(0)) cb(now); } return true; };
})();"""
STEP_JS = "(n) => window.__ptStep(n)"


class WebAdapter(Adapter):
    def __init__(self, cfg, page=None, bugs="", debug=False, headless=True, offline=False, sam_client=None,
                 profile_dir=None, serve_port=None):
        from pt.sam_sensor import configure
        self.cfg, self.bugs, self.debug = cfg, bugs, debug
        configure(self, sam_client)
        self.offline, self.headless = offline, headless
        self._blocked, self._hosts, self._local = 0, set(), 0
        self._recording = None
        self.name, self.controls, self.goal = cfg["name"], cfg.get("controls", ""), cfg.get("goal", "")
        self.executed = []
        self._pw = self._browser = self._persistent_context = None
        self._served = None
        serve = cfg.get('serve')
        url = cfg.get('url', '')
        if offline and not serve and (url.startswith('file:') or '://' not in url):
            path = Path(url2pathname(urlsplit(url).path)) if url.startswith('file:') else (ROOT / url).resolve()
            serve = {'dir': path.parent, 'path': path.name}
        self._serve = serve
        self._screen = None              # real time recording of a game with no frame counter: (folder, wall clock start)
        self.frame_lock = bool(cfg.get("frame_lock"))
        try:                             # a game that fails to load must not leave its browser or server running
            if serve:
                # Reopening a saved profile needs the same port: localStorage belongs to the origin.
                self._served = serve_dir(ROOT / serve['dir'], serve.get('port', 0) if serve_port is None else serve_port)
            if page is None:
                from playwright.sync_api import sync_playwright
                self._pw = sync_playwright().start()
                options = {"headless": headless}
                if offline:
                    options['args'] = ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1']
                if profile_dir is None:
                    self._browser = self._pw.chromium.launch(**options)
                    page = self._browser.new_page(viewport=self._viewport(), **self._page_options())
                else:
                    self._persistent_context = self._pw.chromium.launch_persistent_context(
                        str(profile_dir), viewport=self._viewport(), **options, **self._page_options())
                    page = (self._persistent_context.pages or [None])[0] or self._persistent_context.new_page()
            self.page = page
            self._load()
        except BaseException:
            self.close()
            raise
        self.keys = {**DEFAULT_KEYS, **(cfg.get("keys") or {})}
        self.hold_frames = cfg.get("hold_frames", 15)
        self.settle_frames = cfg.get("settle_frames", 4)

    def _viewport(self):
        return self.cfg.get("viewport") or {"width": 1280, "height": 720}

    def _page_options(self):
        return {'service_workers': 'block'} if self.offline else {}

    def _load(self):
        if self.frame_lock:
            self.page.add_init_script(FRAME_LOCK_JS)
        if self.offline:
            self.page.route("**/*", self._offline_route)
        if self._served:
            base = self._served.url + self._serve.get("path", "")
            q = {k: v.format(bugs=self.bugs, debug="1" if self.debug else "") for k, v in (self.cfg.get("url_query") or {}).items()}
            q = {k: v for k, v in q.items() if v != ""}
            self.page.goto(base + ("?" + urlencode(q) if q else ""))
        else:
            self.page.goto(build_url(self.cfg, bugs=self.bugs, debug="1" if self.debug else ""))
        self._wait_ready()

    def _offline_route(self, route):
        url = urlsplit(route.request.url)
        if url.scheme in ('data', 'about') or url.hostname in ('127.0.0.1', 'localhost', '::1'):
            self._local += 1
            route.continue_()
        else:
            self._blocked += 1
            if url.hostname:
                self._hosts.add(url.hostname)
            route.abort()

    def offline_report(self):
        return {"blocked_connections": self._blocked, "hosts": sorted(self._hosts),
                "allowed_local_connections": self._local}

    def tick(self):
        js = self.cfg.get('frame_js')
        v = self.page.evaluate(js) if js else None
        return None if v is None else getattr(self, '_tick_base', 0) + v

    def reload(self):
        """Start the game again from its first screen, like a tester who closes it and opens it. Frame numbers and bug counts carry on."""
        if self.cfg.get('frame_js'):
            self._tick_base = self.tick() + 1
        self._hits = self.bug_hits()
        self.page.reload()
        self._wait_ready()

    def _wait_ready(self):
        js = self.cfg.get("ready_js")
        if not js:
            return
        if not self.frame_lock:
            self.page.wait_for_function(js)
            return
        for _ in range(600):
            if self.page.evaluate(js):
                return
            self.page.evaluate(STEP_JS, 1)
        raise TimeoutError("the game was not ready after 600 frames")

    def start_recording(self, folder):
        if not self.cfg.get('frame_js'):
            # No frame counter (some games stall under the frame lock): film the page in real time, like the phone.
            # The page is opened again inside a recording context; nothing has been played yet.
            if self._browser is None:
                raise ValueError('recording a game with no frame_js needs the adapter to open its own browser')
            old = self.page
            context = self._browser.new_context(viewport=self._viewport(), record_video_dir=str(Path(folder) / 'video'),
                                                record_video_size=self._viewport(), **self._page_options())
            self._screen = (Path(folder), time.time())
            self.page = context.new_page()
            old.close()
            self._load()
            return
        self._recording = Path(folder) / 'frames'
        self._recording.mkdir(parents=True, exist_ok=True)

    def _save_frame(self):
        from pt.vision import filter_screenshot

        shot = self.page.screenshot(type='jpeg', quality=80)
        saved = filter_screenshot(shot, getattr(self, '_recording_vision', 'normal'))
        (self._recording / f'f{self.tick():08d}.jpg').write_bytes(saved)
        # The loop filters the raw observation once before sending it to the model.
        return shot

    def set_recording_vision(self, mode):
        """Use the model's vision mode for intermediate saved recording frames."""
        self._recording_vision = mode

    def _frames(self, n):
        if self._recording is not None:
            for start in range(0, n, 2):
                self._step_frames(min(2, n - start))
                self._save_frame()
        else:
            self._step_frames(n)

    def _step_frames(self, n):
        if self.frame_lock:
            self.page.evaluate(STEP_JS, n)
            return
        f = self.cfg.get("frame_js")
        if not f:
            self.page.wait_for_timeout(int(n * 1000 / 60))
            return
        js = ("(n) => new Promise(res => { const f = () => (" + f + "); const t = f() + n; (function w() { f() >= t ? res() : requestAnimationFrame(w); })(); })")
        self.page.evaluate(js, n)

    def _key(self, k):
        return self.keys.get(k.lower(), k)

    def execute(self, actions):
        """last_spans: for each action, the game frame it started on, the frame its keys were let go, and the frame it ended
        (only for a game with a frame counter). The run video draws each key on exactly those frames."""
        from pt.sam_sensor import advance
        self.action_note = ""
        refused = []
        counted = bool(self.cfg.get("frame_js"))
        self.last_spans = []
        for a in actions:
            self.executed.append(a)
            t = a.get("type")
            span = {"from": self.tick()} if counted else None
            from_s = time.time()
            if t == "keypress":
                keys = [self._key(k) for k in a.get("keys", [])]
                for k in keys:
                    self.page.keyboard.down(k)
                if self.cfg.get("frame_js"):
                    self._frames(self.hold_frames)
                    span["held_to"] = self.tick()
                else:
                    self.page.wait_for_timeout(250)
                for k in reversed(keys):
                    self.page.keyboard.up(k)
                if self.cfg.get("frame_js"):
                    self._frames(self.settle_frames)
                else:
                    self.page.wait_for_timeout(60)
            elif t == "wait":
                self._frames(max(1, int(a.get("ms", 800) * 60 / 1000))) if self.cfg.get("frame_js") else self.page.wait_for_timeout(a.get("ms", 800))
            elif t == "click":
                self.page.mouse.click(a["x"], a["y"])
            elif t == "type":
                self.page.keyboard.type(a.get("text", ""))
            elif t == "reload":
                self.reload()
            elif t != "screenshot":
                refused.append(t)
            if counted:
                span["to"] = self.tick()
                span.setdefault("held_to", span["to"])
                self.last_spans.append(span)
            elif self._screen is not None:       # wall clock, as the phone's spans
                self.last_spans.append({"from_s": from_s, "to_s": time.time()})
        advance(self)
        if refused:
            self.action_note = "; ".join(f"action refused: {kind}" for kind in refused)

    def screenshot(self):
        from pt.sam_sensor import observe
        if self._recording is not None:
            return observe(self, self._save_frame())
        return observe(self, self.page.screenshot(type="jpeg", quality=70))

    def state(self):
        js = self.cfg.get("state_js")
        return self.page.evaluate(js) if js else super().state()

    def won(self):
        js = self.cfg.get("won_js")
        return bool(self.page.evaluate(js)) if js else None

    def bug_hits(self):
        js = self.cfg.get("bug_js")
        hits = self.page.evaluate(js) if js else None
        before = getattr(self, "_hits", None)
        if isinstance(hits, dict) and isinstance(before, dict):
            hits = {k: bool(hits.get(k)) or bool(before.get(k)) for k in {**before, **hits}}
        return hits

    def fresh(self):
        copy = WebAdapter(self.cfg, bugs=self.bugs, debug=self.debug, headless=self.headless, offline=self.offline)
        if getattr(self, "_sam_sensor", None) is not None:
            copy._sam_sensor = self._sam_sensor
        return copy

    def _finish_screen(self):
        """Close the recording context so the video is written, then keep it as screen.mp4 with its wall clock start."""
        folder, started = self._screen
        self._screen = None
        video = self.page.video
        self.page.context.close()
        webm = Path(video.path())
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(webm), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", str(folder / "screen.mp4")], check=True)
        duration = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                         str(folder / "screen.mp4")], capture_output=True, text=True, check=True).stdout.strip())
        (folder / "screen_segments.json").write_text(json.dumps([{"start": started, "duration": duration}]), encoding="utf-8")
        webm.unlink()
        webm.parent.rmdir()

    def close(self):
        if self._screen is not None:
            self._finish_screen()
        if self._persistent_context:
            self._persistent_context.close()
        if self._browser:
            self._browser.close()
        if self._pw:
            self._pw.stop()
        if self._served:
            self._served.stop()


def config_path(name):
    """games.local/<name>.json (private, never committed) wins over games/<name>.json."""
    local = ROOT / "games.local" / f"{name}.json"
    return local if local.exists() else ROOT / "games" / f"{name}.json"


def make(name="cave-courier", bugs="", debug=False, offline=False, sam_client=None):
    """Open a game by the name of its config file."""
    cfg = load_config(config_path(name))
    if cfg["type"] == "pcgame":
        from pt.pcgame import PcGameAdapter
        return PcGameAdapter(cfg, sam_client=sam_client)
    if cfg["type"] == "android":
        from pt.android import AndroidAdapter
        if sam_client is not None:
            return AndroidAdapter(cfg, sam_client=sam_client)
        return AndroidAdapter(cfg)
    if cfg["type"] == "doom":
        from pt.doom import DoomAdapter
        return DoomAdapter(cfg)
    options = {'offline': True} if offline else {}
    if sam_client is not None:
        options['sam_client'] = sam_client
    return WebAdapter(cfg, bugs=bugs, debug=debug, **options)
