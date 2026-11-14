import io
import os
from pathlib import Path
import subprocess
import time

from PIL import Image

from pt.adapter import Adapter


class Adb:
    def __init__(self, serial, port, runner=None):
        self.serial, self.port = serial, port
        self.runner = runner or self._run
        self.path = "adb"
        roots = []
        if os.environ.get("ANDROID_HOME"):
            roots.append(Path(os.environ["ANDROID_HOME"]))
        if os.environ.get("LOCALAPPDATA"):
            roots.append(Path(os.environ["LOCALAPPDATA"]) / "Android" / "Sdk")
        for root in roots:
            for name in ("adb.exe", "adb"):
                path = root / "platform-tools" / name
                if path.is_file():
                    self.path = str(path)
                    return

    def _run(self, args, timeout):
        env = {**os.environ, "ANDROID_ADB_SERVER_PORT": str(self.port)}
        return subprocess.run(args, env=env, timeout=timeout, capture_output=True, check=True).stdout

    def run(self, *args, timeout=30):
        try:
            return self.runner([self.path, "-s", self.serial, *map(str, args)], timeout=timeout)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            stderr = e.stderr or b""
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(stderr[:200]) from e


class AndroidAdapter(Adapter):
    paced_replay = True

    def __init__(self, cfg, adb=None, sleep=None, clock=time.time, sam_client=None):
        from pt.sam_sensor import configure
        self.cfg = cfg
        configure(self, sam_client)
        self.clock = clock
        self.name, self.controls, self.goal = cfg["name"], cfg.get("controls", ""), cfg.get("goal", "")
        self.adb = adb if adb is not None else Adb(cfg.get("serial", ""), cfg.get("adb_port", 25037))
        self.shot_width = cfg.get("shot_width", 540)
        self.executed = []
        self.setup_log = []
        self.sleep = sleep or time.sleep
        self.scale = 1
        self.device_size = self.shot_size = None
        package = cfg["package"]
        self.adb.run("shell", "am", "force-stop", package)
        if cfg.get("clear_data", False):
            self.adb.run("shell", "pm", "clear", package)
        self.adb.run("shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1")
        self.sleep(cfg.get("launch_wait_s", 6))
        for step in cfg.get("setup", []):
            if "tap" in step:
                self.adb.run("shell", "input", "tap", *map(str, step["tap"]))
            elif "swipe" in step:
                self.adb.run("shell", "input", "swipe", *map(str, step["swipe"]))
            elif "key" in step:
                self.adb.run("shell", "input", "keyevent", "KEYCODE_" + step["key"].upper())
            elif "wait" in step:
                self.sleep(step["wait"] / 1000)
            else:
                raise ValueError("unknown setup step")
            self.setup_log.append(dict(step))

    def screenshot(self):
        from pt.sam_sensor import observe
        png = self.adb.run("exec-out", "screencap", "-p")
        with Image.open(io.BytesIO(png)) as im:
            self.device_size = im.size
            self.scale = im.width / self.shot_width
            self.shot_size = (self.shot_width, max(1, round(im.height / self.scale)))
            shot = im.convert("RGB").resize(self.shot_size, Image.Resampling.LANCZOS)
        out = io.BytesIO()
        shot.save(out, format="JPEG", quality=70)
        return observe(self, out.getvalue())

    def _point(self, x, y):
        if self.shot_size is None:
            self.screenshot()
        w, h = self.shot_size
        return str(int(max(0, min(w - 1, x)) * self.scale)), str(int(max(0, min(h - 1, y)) * self.scale))

    def execute(self, actions):
        """last_spans: the wall clock start and end of each action, for the run video (a phone runs in real time)."""
        from pt.sam_sensor import advance
        self.action_note = ""
        self.last_spans = []
        refused = []
        for a in actions:
            self.executed.append(a)
            span = {"from_s": self.clock()}
            self._run_action(a)
            if a.get("type") not in {"click", "swipe", "keypress", "wait"}:
                refused.append(a.get("type"))
            span["to_s"] = self.clock()
            self.last_spans.append(span)
        advance(self)
        if refused:
            self.action_note = "; ".join(f"action refused: {kind}" for kind in refused)

    def _run_action(self, a):
        kind = a.get("type")
        if kind == "click":
            self.adb.run("shell", "input", "tap", *self._point(a["x"], a["y"]))
        elif kind == "swipe":
            self.adb.run("shell", "input", "swipe", *self._point(a["x"], a["y"]),
                         *self._point(a["x2"], a["y2"]), str(a.get("ms", 300)))
        elif kind == "keypress":
            keys = {"back": "KEYCODE_BACK", "home": "KEYCODE_HOME", "enter": "KEYCODE_ENTER"}
            for key in a.get("keys", []):
                self.adb.run("shell", "input", "keyevent", keys.get(key.lower(), key))
        elif kind == "wait":
            self.sleep(a.get("ms", 800) / 1000)

    def fresh(self):
        raise NotImplementedError("a phone game cannot be replayed from here")

    def close(self):
        pass
