"""PC guards before and during a browser run. Every probe is injected, so no test touches the PC."""
import os
from pt import guard as G


def ok_probes(**kw):
    p = {"gpu": lambda: 10, "comfy": lambda: [], "free_gb": lambda: 20.0, "min_free": lambda: 8.0, "games": lambda: [], "lock_holder": lambda: None}
    p.update(kw)
    return p


def test_all_clear():
    assert G.problems(ok_probes()) == []


def test_gpu_over_40_blocks():
    assert any("GPU" in x for x in G.problems(ok_probes(gpu=lambda: 41)))
    assert G.problems(ok_probes(gpu=lambda: 40)) == []


def test_comfy_job_blocks():
    r = G.problems(ok_probes(comfy=lambda: ["8188 has 1 running"]))
    assert any("ComfyUI" in x for x in r)


def test_low_memory_blocks():
    assert any("memory" in x for x in G.problems(ok_probes(free_gb=lambda: 7.9)))
    assert G.problems(ok_probes(free_gb=lambda: 8.0)) == []


def test_game_window_blocks():
    r = G.problems(ok_probes(games=lambda: ["Marvel-Win64-Shipping"]))
    assert any("Marvel-Win64-Shipping" in x for x in r)


def test_second_run_blocks():
    assert any("another run" in x for x in G.problems(ok_probes(lock_holder=lambda: 4242)))


def test_unreadable_probe_blocks_not_passes():
    def boom():
        raise OSError("no nvidia-smi")
    r = G.problems(ok_probes(gpu=boom))
    assert any("could not read GPU" in x for x in r)


def test_no_nvidia_tool_means_no_gpu_to_share(monkeypatch):
    """A judge PC with no NVIDIA card has no nvidia-smi. That is not an unreadable GPU: there is no GPU job to share with."""
    monkeypatch.setattr(G.shutil, "which", lambda name: None)
    assert G.gpu_percent() == 0


def test_free_memory_on_linux(tmp_path):
    mi = tmp_path / "meminfo"
    mi.write_text("MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8388608 kB\n")
    assert G.free_gb(platform="linux", meminfo=mi) == 8.0


def test_free_memory_on_a_mac():
    text = ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                              131072.\n"
            "Pages active:                            900000.\nPages inactive:                          262144.\nPages speculative:                       131072.\n")
    assert G.free_gb(platform="darwin", vm_stat=lambda: text) == 8.0


def test_game_windows_are_a_windows_check():
    assert G.game_windows(platform="darwin") == [] and G.game_windows(platform="linux") == []


def test_is_game_process():
    assert G.is_game(r"A:\SteamLibrary\steamapps\common\Marvel Rivals\MarvelGame\Marvel\Binaries\Win64\Marvel-Win64-Shipping.exe")
    assert G.is_game(r"C:\x\Thing-Win64-Shipping.exe")
    assert not G.is_game(r"C:\Windows\System32\WindowsTerminal.exe")
    assert not G.is_game(r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def test_lock_roundtrip(tmp_path):
    lk = tmp_path / "run.lock"
    assert G.lock_holder(lk) is None
    G.take_lock(lk)
    assert G.lock_holder(lk) is None or G.lock_holder(lk) == os.getpid()   # our own lock is not "another run"
    G.release_lock(lk)
    assert not lk.exists()


def test_stale_lock_is_ignored(tmp_path):
    lk = tmp_path / "run.lock"
    lk.write_text("999999999")                       # no such process
    assert G.lock_holder(lk) is None


def test_memory_stop_rule():
    assert G.must_stop(free_gb=7.5) is True
    assert G.must_stop(free_gb=8.0) is False


def test_alive_check_does_not_kill_the_process():
    import subprocess, sys, time
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert G._alive(p.pid) is True
        time.sleep(0.5)
        assert p.poll() is None            # still running after the check
    finally:
        p.kill(); p.wait()
    assert G._alive(p.pid) is False


def emu_probes(**kw):
    p = ok_probes(comfy_up=lambda: [], browsers=lambda: 0, unity=lambda: 0)
    p.update(kw)
    return p


def test_emulator_all_clear():
    assert G.emulator_problems(emu_probes()) == []


def test_emulator_blocked_by_comfyui_server_or_lock():
    assert any("ComfyUI" in x for x in G.emulator_problems(emu_probes(comfy_up=lambda: ["port 8188 is listening"])))
    assert any("ComfyUI" in x for x in G.emulator_problems(emu_probes(comfy_up=lambda: ["comfy.lock exists"])))


def test_emulator_blocked_by_a_browser_run():
    assert any("browser" in x for x in G.emulator_problems(emu_probes(browsers=lambda: 3)))


def test_emulator_unreadable_probe_blocks():
    def boom():
        raise OSError("x")
    assert G.emulator_problems(emu_probes(browsers=boom))


def test_comfy_up_reads_lock_and_port(tmp_path):
    lock = tmp_path / "comfy.lock"
    assert G.comfy_up(lock_path=lock, listening=lambda port: False) == []
    lock.write_text("x")
    assert any("comfy.lock" in x for x in G.comfy_up(lock_path=lock, listening=lambda port: False))
    assert any("8188" in x for x in G.comfy_up(lock_path=tmp_path / "none", listening=lambda port: port == 8188))


def test_emulator_blocked_by_a_unity_editor():
    assert any("Unity" in x for x in G.emulator_problems(emu_probes(unity=lambda: 2)))
    assert G.emulator_problems(emu_probes(unity=lambda: 0)) == []


def test_memory_floor_fits_the_machine():
    """28 Oct, a 2 GB Ubuntu droplet run as a judge: "BLOCKED: free memory is 1.6 GB (limit 8.0 GB)". The 8 GB floor is for the
    owner's 61.5 GB PC (ComfyUI and games share it). A judge's laptop gets a quarter of its memory, at least 1 GB, at most 8."""
    assert G.min_free_gb(61.5) == 8.0
    assert G.min_free_gb(16.0) == 4.0
    assert G.min_free_gb(2.0) == 1.0
    assert G.problems(ok_probes(free_gb=lambda: 1.6, min_free=lambda: 1.0)) == []
    assert any("memory" in x for x in G.problems(ok_probes(free_gb=lambda: 0.9, min_free=lambda: 1.0)))


def test_total_memory_on_linux_and_a_mac(tmp_path):
    mi = tmp_path / "meminfo"
    mi.write_text("MemTotal:        2014208 kB\nMemAvailable:    1600000 kB\n")
    assert round(G.total_gb(platform="linux", meminfo=mi), 2) == 1.92
    assert G.total_gb(platform="darwin", sysctl=lambda: "17179869184\n") == 16.0


def test_comfy_up_finds_the_lock_named_by_the_setting(tmp_path, monkeypatch):
    from pt import env
    monkeypatch.setattr(env, 'load_local_env', lambda: None)
    lock = tmp_path / 'comfy.lock'
    lock.write_text('x')
    monkeypatch.setenv('PLAYTEST_COMFY_LOCK', str(lock))
    assert G.comfy_up(listening=lambda port: False) == ['comfy.lock exists']


def test_comfy_up_with_no_setting_reads_not_running(monkeypatch):
    monkeypatch.delenv('PLAYTEST_COMFY_LOCK', raising=False)
    monkeypatch.setattr('pt.env.load_local_env', lambda: None)
    assert G.comfy_up(listening=lambda port: False) == []


def test_comfy_up_with_no_setting_still_reads_the_port(monkeypatch):
    monkeypatch.delenv('PLAYTEST_COMFY_LOCK', raising=False)
    monkeypatch.setattr('pt.env.load_local_env', lambda: None)
    assert G.comfy_up(listening=lambda port: port == 8188) == ['port 8188 is listening']


def test_guard_holds_no_drive_path():
    from pathlib import Path
    import re
    source = Path(__file__).resolve().parents[1] / 'pt/guard.py'
    assert not re.search(r'\b[A-Za-z]:[/\\]', source.read_text())
