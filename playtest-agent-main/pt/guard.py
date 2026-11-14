"""PC guards for a browser run: GPU, ComfyUI, free memory, game windows, one run at a time.
A probe that cannot be read counts as a problem, never as a pass. Every probe can be replaced for tests."""
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

GPU_MAX_PERCENT = 40
MIN_FREE_GB = 8.0
COMFY_PORTS = (8188, 8189)
LOCK = Path(__file__).resolve().parents[1] / "data" / "run.lock"


def gpu_percent():
    if shutil.which("nvidia-smi") is None:          # no NVIDIA card (a judge's laptop, a Mac): no GPU job to share with
        return 0
    out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=15, check=True).stdout
    return max(int(x) for x in out.split())


def comfy_busy():
    """Lines describing a ComfyUI with a running or waiting job. A port with nothing listening is not busy."""
    busy = []
    for port in COMFY_PORTS:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/queue", timeout=3) as r:
                q = json.loads(r.read())
        except OSError:
            continue
        n = len(q.get("queue_running", [])) + len(q.get("queue_pending", []))
        if n:
            busy.append(f"port {port} has {n} job(s)")
    return busy


class _MemStatus(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong), ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]


def _vm_stat():
    return subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=15, check=True).stdout


def free_gb(platform=sys.platform, meminfo=Path("/proc/meminfo"), vm_stat=_vm_stat):
    """Free memory in GB on Windows, Linux or a Mac. A judge may run on any of the three."""
    if platform == "win32":
        s = _MemStatus(); s.dwLength = ctypes.sizeof(s)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
        return s.ullAvailPhys / 2 ** 30
    if platform == "darwin":
        text = vm_stat()
        page = int(re.search(r"page size of (\d+) bytes", text).group(1))
        pages = sum(int(re.search(rf"Pages {k}:\s+(\d+)", text).group(1)) for k in ("free", "inactive", "speculative"))
        return pages * page / 2 ** 30
    for line in Path(meminfo).read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) / 2 ** 20                     # kB
    raise OSError("no MemAvailable line")


def _sysctl_memsize():
    return subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=15, check=True).stdout


def total_gb(platform=sys.platform, meminfo=Path("/proc/meminfo"), sysctl=_sysctl_memsize):
    """All memory in GB on Windows, Linux or a Mac."""
    if platform == "win32":
        s = _MemStatus(); s.dwLength = ctypes.sizeof(s)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
        return s.ullTotalPhys / 2 ** 30
    if platform == "darwin":
        return int(sysctl().strip()) / 2 ** 30
    for line in Path(meminfo).read_text().splitlines():
        if line.startswith("MemTotal:"):
            return int(line.split()[1]) / 2 ** 20
    raise OSError("no MemTotal line")


def min_free_gb(total):
    """The free memory a run needs. 8 GB on the owner's 61.5 GB PC, where ComfyUI and games share it. A smaller machine (a judge's
    laptop, a 2 GB server) gets a quarter of its memory, at least 1 GB: a headless browser run needs well under that.
    Found 28 Oct on a 2 GB Ubuntu server: "BLOCKED: free memory is 1.6 GB (limit 8.0 GB)"."""
    return min(MIN_FREE_GB, max(1.0, total * 0.25))


def is_game(exe_path):
    bs = chr(92)
    p = (exe_path or "").lower().replace("/", bs)
    return any(x in p for x in (bs + "steamapps" + bs, bs + "epic games" + bs, bs + "riot games" + bs)) or p.endswith("-shipping.exe")


def game_windows(platform=sys.platform):
    """Names of processes that own a visible window and run from a game folder or have a game style name.
    A Windows check (the owner's gaming PC); other systems have no such list here."""
    if platform != "win32":
        return []
    ps =("Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { try { $_.ProcessName + '|' + $_.Path } catch { $_.ProcessName + '|' } }")
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=60, check=True).stdout
    names = []
    for line in out.splitlines():
        name, _, path = line.partition("|")
        if is_game(path) or name.lower().endswith("-shipping"):
            names.append(name)
    return names


def doom_hold(games=None):
    """'HELD - <game> is open' while a game window is open, else None. The Doom engine never runs beside the owner's game, his
    words 28 Oct: "can u tell the agent not to run doom while I am gaming?". A window list that cannot be read holds too."""
    try:
        open_games = (games or game_windows)()
    except Exception as e:
        return f"HELD - the window list could not be read ({type(e).__name__})"
    return f"HELD - {open_games[0]} is open" if open_games else None


def _alive(pid):
    """Is this process running? Never signals it: on Windows os.kill(pid, 0) ends the process."""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except PermissionError:
            return True
        except OSError:
            return False
        return True
    import ctypes
    k = ctypes.windll.kernel32
    k.OpenProcess.restype = ctypes.c_void_p
    h = k.OpenProcess(0x1000, False, pid)          # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return k.GetLastError() == 5                # access denied: it exists
    try:
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(ctypes.c_void_p(h), ctypes.byref(code))
        return bool(ok) and code.value == 259       # STILL_ACTIVE
    finally:
        k.CloseHandle(ctypes.c_void_p(h))


def lock_holder(path=LOCK):
    """Pid of ANOTHER live run, or None. A lock of a dead process, or our own, is not a holder."""
    try:
        pid = int(Path(path).read_text().strip())
    except (OSError, ValueError):
        return None
    if pid == os.getpid() or not _alive(pid):
        return None
    return pid


def take_lock(path=LOCK):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(str(os.getpid()))


def release_lock(path=LOCK):
    try:
        Path(path).unlink()
    except OSError:
        pass


def comfy_lock():
    """The lock file named by PLAYTEST_COMFY_LOCK, or None when no lock is set for this PC."""
    from pt import env
    env.load_local_env()
    value = os.environ.get("PLAYTEST_COMFY_LOCK", "").strip()
    return Path(value) if value else None


def _listening(port):
    import socket
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def comfy_up(lock_path=None, listening=_listening):
    """ComfyUI is held (server listening or its lock file present), whether or not a job is queued."""
    out = [f"port {p} is listening" for p in COMFY_PORTS if listening(p)]
    if lock_path is None:
        lock_path = comfy_lock()
    if lock_path is not None and Path(lock_path).exists():
        out.append("comfy.lock exists")
    return out


def browsers():
    """Number of headless browser processes on the PC (another session's Playwright run)."""
    out = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-Process chrome-headless-shell -ErrorAction SilentlyContinue | Measure-Object).Count"],
                         capture_output=True, text=True, timeout=30, check=True).stdout
    return int(out.strip() or 0)


def unity_editors():
    """Number of running Unity editor processes (Unity Hub is a different process and does not count)."""
    out = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-Process Unity -ErrorAction SilentlyContinue | Measure-Object).Count"],
                         capture_output=True, text=True, timeout=30, check=True).stdout
    return int(out.strip() or 0)


def emulator_problems(probes=None):
    """The checks for starting the phone emulator: the browser run checks plus no ComfyUI held and no browser run at all."""
    p = {"comfy_up": comfy_up, "browsers": browsers, "unity": unity_editors, **(probes or {})}
    out = problems(probes)
    try:
        out += [f"ComfyUI is held: {x}" for x in p["comfy_up"]()]
    except Exception as e:
        out.append(f"could not read the ComfyUI hold ({type(e).__name__})")
    try:
        n = p["browsers"]()
        if n:
            out.append(f"a browser run is going ({n} headless browser processes)")
    except Exception as e:
        out.append(f"could not count browser processes ({type(e).__name__})")
    try:
        n = p["unity"]()
        if n:
            out.append(f"a Unity editor is running ({n} process(es))")
    except Exception as e:
        out.append(f"could not count Unity editors ({type(e).__name__})")
    return out


def must_stop(free_gb, floor=MIN_FREE_GB):
    return free_gb < floor


DEFAULT = {"gpu": gpu_percent, "comfy": comfy_busy, "free_gb": free_gb, "min_free": lambda: min_free_gb(total_gb()),
           "games": game_windows, "lock_holder": lock_holder}


def problems(probes=None):
    p = {**DEFAULT, **(probes or {})}
    out = []
    try:
        g = p["gpu"]()
        if g > GPU_MAX_PERCENT:
            out.append(f"GPU is {g}% used (limit {GPU_MAX_PERCENT}%)")
    except Exception as e:
        out.append(f"could not read GPU use ({type(e).__name__})")
    try:
        out += [f"ComfyUI is busy: {x}" for x in p["comfy"]()]
    except Exception as e:
        out.append(f"could not read the ComfyUI queue ({type(e).__name__})")
    try:
        f, floor = p["free_gb"](), p["min_free"]()
        if f < floor:
            out.append(f"free memory is {f:.1f} GB (limit {floor:.1f} GB)")
    except Exception as e:
        out.append(f"could not read free memory ({type(e).__name__})")
    try:
        out += [f"a game window is open: {x}" for x in p["games"]()]
    except Exception as e:
        out.append(f"could not list windows ({type(e).__name__})")
    try:
        h = p["lock_holder"]()
        if h:
            out.append(f"another run holds the lock (pid {h})")
    except Exception as e:
        out.append(f"could not read the run lock ({type(e).__name__})")
    return out


if __name__ == "__main__":
    pr = emulator_problems() if "--emulator" in sys.argv else problems()
    print("OK" if not pr else "BLOCKED: " + "; ".join(pr))
    sys.exit(0 if not pr else 1)
