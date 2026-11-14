"""python -m pt goal|hunt NAME [options], python -m pt confirm|report RUN_FOLDER, python -m pt guard"""
import argparse
import json
import re
import sys
from pathlib import Path

def hunt_text(steps=60, reload=False):
    """The bug hunt method. It names no part of any game, so it works the same for every game."""
    stuck = ("Being stuck is a bug only after every way out failed: jump while you hold each direction, jump twice, "
             "and press the game's own restart. Try all of them first, then report only the ones that failed. ")
    trapped = stuck + ("Then use the reload action and carry on with what you have not tested. "
                       if reload else "After a trap you may not be able to carry on. ")
    return ("You are a game tester. You have about " + str(steps) + " steps to find every bug you can. Work in this order. "
            "First, look at the first screen and note every object, sign, price and number on it. "
            "Test the things near the start before you go far away. Test each thing by its own action: walk to it, use it, jump on it, pick it up. "
            "Stand right next to anything that blocks your way and press the use control there before you decide it is a wall. "
            "After every pickup, purchase or use, read every number on the screen again. Check the change against what the game told you, "
            "and against the change the same kind of thing gave before. A different amount is a bug. "
            "When a thing costs something, collect enough to pay, buy it, and check that you got what you paid for. "
            "When something looks wrong, call report_bug at once and say what you expected and what you saw. "
            "File one report per problem, never two problems in one report. "
            "Leave anything that could trap you or end your run (a pit, an edge, a restart control) for last. " + trapped +
            "Do not report things that work. Stop only when you have tested everything you saw.")


HUNT = hunt_text()
ROOT = Path(__file__).resolve().parents[1]


def model_options(parser, resume=False):
    parser.add_argument("--model", choices=["wonder", "glimmer-local"], default=None if resume else "wonder")
    parser.add_argument("--glimmer-url", default="http://127.0.0.1:8090/v1")
    parser.add_argument("--reasoning", choices=["low", "medium", "high"], default="low")


def parse(argv):
    p = argparse.ArgumentParser(prog="pt")
    from pt import __version__
    p.add_argument("--version", action="version", version="pt " + __version__)
    sub = p.add_subparsers(dest="cmd", required=True)
    from pt.exploit import add_parser as add_exploit_parser
    add_exploit_parser(sub)
    from pt.duo import add_parser
    add_parser(sub)
    from pt.reduce import add_parser as add_reduce_parser
    add_reduce_parser(sub)
    from pt.goal_clean import add_parser as add_goal_clean_parser
    add_goal_clean_parser(sub)
    from pt.goal_buggy import add_parser as add_goal_buggy_parser
    add_goal_buggy_parser(sub)
    from pt.challenge import add_parser as add_challenge_parser
    add_challenge_parser(sub)
    from pt.contract import add_parser as add_contract_parser
    add_contract_parser(sub)
    from pt.hostile import add_parser as add_hostile_parser
    add_hostile_parser(sub)
    from pt.persist import add_parser as add_persist_parser
    add_persist_parser(sub)
    from pt.replay_check import add_parser as add_replay_check_parser
    add_replay_check_parser(sub)
    from pt.fix_any import add_parser as add_fix_any_parser
    add_fix_any_parser(sub)
    for kind in ("goal", "hunt", "resume"):
        s = sub.add_parser(kind, help={"goal": "a goal run", "hunt": "a bug hunt", "resume": "continue a saved run"}[kind])
        s.add_argument("name")
        model_options(s, resume=kind == "resume")
        if kind == "resume":
            s.add_argument("--note", required=True)
        s.add_argument("--checklist", action="store_true")
        s.add_argument("--allow-game-window", action="store_true", help="skip only the game window check (for a run that uses no browser, no GPU and no window)")
        s.add_argument("--allow-gpu", action="store_true", help="skip only the GPU percentage check")
        s.add_argument("--allow-comfy", action="store_true", help="skip only the ComfyUI queue check (for a run with no browser and no GPU)")
        s.add_argument("--offline", action="store_true")
        s.add_argument("--narrate", action="store_true")
        if kind in ("goal", "hunt"):
            s.add_argument("--record", action="store_true")
            from pt.vision import MODES
            s.add_argument("--vision", choices=MODES, default="normal")
        s.add_argument("--escalate", action="store_true", help="offer the escalate tool (off in scored runs)")
        s.add_argument("--game", default="cave-courier")
        s.add_argument("--bugs", default=None, help="test game only: planted bugs to switch on, like 1,2,3")
        s.add_argument("--clean", action="store_true", help="a clean run: every planted bug off; refused if --bugs names any")
        s.add_argument("--state", action="store_true", help="also send the game's state text to the agent")
        s.add_argument("--effort", default="low", choices=["minimal", "low", "medium", "high"])
        s.add_argument("--max-steps", type=int, default=60)
        s.add_argument("--max-seconds", type=int, default=900)
        s.add_argument("--max-usd", type=float, default=2.5)
        s.add_argument("--max-out", type=int, default=3000, help="output token limit per step (reasoning shares it)")
        s.add_argument("--history", default="own", choices=["own", "server"], help="own: send the whole turn list each step (fast); server: the stored chain")
        s.add_argument("--summary", default=None, choices=["auto", "concise", "detailed"], help="ask for a readable summary of the model's reasoning; logged as thinking")
        s.add_argument("--look-plan", action="store_true", help="ask for LOOK and PLAN lines before every act call")
        s.add_argument("--notes", action="store_true", help="a notes field in every act call: places seen, things tried, the next place not explored")
    for kind in ("confirm", "report", "console", "signoff", "contrast"):
        s = sub.add_parser(kind)
        s.add_argument("folder")
        if kind == "confirm":
            model_options(s)
            s.add_argument("--judge-input", choices=["strip", "video"], default="strip")
            s.add_argument("--offline", action="store_true")
            s.add_argument("--allow-gpu", action="store_true", help="skip only the GPU percentage check")
        s.add_argument("--game", default=None, help="confirm: the run's own game unless given")
        if kind == "signoff":
            s.add_argument("--by", required=True)
            s.add_argument("--note", default="")
    s = sub.add_parser("verify")
    s.add_argument("folder")
    s.add_argument("--digest", default=None)
    s = sub.add_parser("regress")
    s.add_argument("folder")
    s.add_argument("--bugs", required=True)
    s.add_argument("--game", default=None)
    s.add_argument("--goal-run", default=None)
    s.add_argument("--name", default=None)
    s.add_argument("--build", default=None, help="replay on a patched Cave Courier HTML copy")
    s.add_argument("--baseline-build", default=None, help="unpatched Cave Courier HTML copy for comparison")
    s = sub.add_parser("issues", help="group confirmed reports into proposed issues")
    s.add_argument("out_folder")
    s.add_argument("runs", nargs="+")
    s.add_argument("--max-calls", type=int, default=8)
    s.add_argument("--no-model", action="store_true")
    s = sub.add_parser("issues-accept")
    s.add_argument("out_folder")
    s.add_argument("group_id")
    s.add_argument("--by", required=True)
    s = sub.add_parser("issues-split")
    s.add_argument("out_folder")
    s.add_argument("group_id")
    s.add_argument("--occurrence", required=True)
    s = sub.add_parser("fix")
    s.add_argument("folder")
    s.add_argument("--goal-run", required=True)
    s.add_argument("--max-tries", type=int, default=3)
    s = sub.add_parser("fix-verify")
    s.add_argument("folder")
    s.add_argument("--goal-run", required=True)
    s.add_argument("--report", type=int, required=True)
    s.add_argument("--try", dest="try_number", type=int, required=True)
    s.add_argument("--name", required=True)
    s.add_argument("--note", default="")
    s.add_argument("--dry", action="store_true")
    sub.add_parser("gate").add_argument("folder")
    sub.add_parser("diary", help="a first person playtest diary from a saved run (one Spark call)").add_argument("folder")
    s = sub.add_parser("deathmap", help="replay saved runs at $0 and map where players went and where lives ended")
    s.add_argument("runs", nargs="+")
    s.add_argument("--game", default=None, help="the first run's own game unless given")
    s.add_argument("--bugs", default=None, help="planted bugs for every replay; each run's own by default")
    s.add_argument("--ground-y", type=int, default=None, help="game y below which the player has fallen; the game config's ground_y by default")
    s.add_argument("--out", default=None, help="folder for deathmap.png and deathmap.json (data/deathmap by default)")
    sub.add_parser("guard")
    return p.parse_args(argv)


def deathmap_cli(a, guard):
    """Replays need a browser, so the PC guard and the run lock apply."""
    from pt import deathmap
    from pt.adapter import config_path, load_config, make
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    first = Path(a.runs[0]) / "result.json"
    game = a.game or (json.loads(first.read_text(encoding="utf-8")).get("game_id") if first.is_file() else None) or "cave-courier"
    cfg = load_config(config_path(game))
    ground = a.ground_y if a.ground_y is not None else cfg.get("ground_y")
    if ground is None:
        print("Give --ground-y: the game y below which the player has fallen")
        return 2
    view = (cfg["viewport"]["width"], cfg["viewport"]["height"])
    guard.take_lock()
    try:
        data = deathmap.build(a.runs, lambda bugs="": make(game, bugs=bugs), Path(a.out) if a.out else ROOT / "data" / "deathmap",
                              ground, view, bugs=a.bugs)
    finally:
        guard.release_lock()
    print(f'{len(data["runs"])} runs, {data["death_count"]} bad ends')
    return 0


def confirm_game(a):
    """A confirm replays on the game the run played (its look too), unless --game names another."""
    if a.game:
        return a.game
    result = Path(a.folder) / "result.json"
    return (json.loads(result.read_text(encoding="utf-8")).get("game_id") if result.is_file() else None) or "cave-courier"


def run_settings(a, game_goal, reload=False):
    bugs = a.bugs
    if bugs is None:
        bugs = "" if getattr(a, "clean", False) else ("1,2,3,4,5" if (a.cmd == "hunt" and a.game == "cave-courier") else "")
    return {"goal": hunt_text(a.max_steps, reload) if a.cmd == "hunt" else game_goal, "bugs": bugs}


CLEAN_NAME = re.compile(r"^cl?\d+$|clean", re.IGNORECASE)     # c10, cl20, clean-final


def clean_problem(a):
    """cl20 (28 Oct) was named as a clean hunt and ran with bugs 1 to 5 on. A run named or flagged clean must have no bugs."""
    if a.cmd not in ("goal", "hunt") or not (getattr(a, "clean", False) or CLEAN_NAME.search(a.name)):
        return None
    bugs = run_settings(a, "")["bugs"]
    if bugs:
        return f'REFUSED: {a.name} is a clean run (by its name or --clean) but planted bugs {bugs} would be on. Pass --bugs "" or --clean.'
    return None


def signoff(folder, by, note):
    from datetime import datetime, timezone
    from pt.report import _load_json, confirmation_status
    from trials.common import save_json
    from pt.seal import digest, manifest

    folder = Path(folder)
    if not (folder / "result.json").is_file():
        print("No result.json in " + str(folder))
        return 1
    result = _load_json(folder / "result.json", {})
    confirmations = _load_json(folder / "confirm.json", [])
    counts = {"confirmed": 0, "rejected": 0, "unverified": 0, "not compared": 0, "input refused in replay": 0}
    for i, rep in enumerate(result.get("reports", [])):
        row = confirmations[i] if i < len(confirmations) else None
        counts[confirmation_status(row)] += 1
    if counts["unverified"]:
        print("Cannot sign off: reports are still unverified. Run python -m pt confirm " + str(folder))
        return 1
    sealed = manifest(folder)
    seal_digest = digest(sealed)
    save_json(folder / "signoff.json", {"by": by, "note": note, "time": datetime.now(timezone.utc).isoformat(),
                                      **{key + "_count": value for key, value in counts.items()},
                                      "manifest": sealed, "digest": seal_digest})
    print(folder / "signoff.json")
    print("Evidence digest: " + seal_digest)
    return 0


def verify(folder, expected_digest=None):
    from pt.report import _load_json
    from pt.seal import check, digest
    saved = _load_json(Path(folder) / "signoff.json", None)
    if not isinstance(saved, dict) or not isinstance(saved.get("manifest"), dict):
        print("No sealed sign off")
        return 1
    if expected_digest is not None and expected_digest != saved.get("digest"):
        print("Digest does not match")
        return 1
    changed = check(folder, saved["manifest"])
    if digest(saved["manifest"]) != saved.get("digest"):
        changed.append("manifest")
    if changed:
        for path in changed:
            print(path)
        return 1
    print("Evidence matches the sign off")
    return 0


def _set_sam_cache_dir(driver, args):
    sensor = getattr(driver, '_sam_sensor', None)
    if sensor is None:
        return
    name = getattr(args, 'name', None)
    if isinstance(name, str) and name:
        run_folder = ROOT / 'data' / 'runs' / name
    else:
        folder = getattr(args, 'folder', None)
        run_folder = ROOT / folder if folder is not None else None
    sensor.cache_dir = run_folder / 'sam_cache' if run_folder is not None else None


def main(argv=None):
    a = parse(argv if argv is not None else sys.argv[1:])
    from pt.env import load_local_env, require_api_key
    load_local_env()
    if a.cmd == "resume" and a.model is None:
        saved = ROOT / "data" / "runs" / a.name / "result.json"
        if saved.is_file():
            try:
                a.model = json.loads(saved.read_text(encoding="utf-8")).get("settings", {}).get("model")
            except (OSError, ValueError):
                pass
    paid = (a.cmd in ("goal", "hunt", "resume") and getattr(a, "model", None) != "glimmer-local")
    paid = paid or (a.cmd == "confirm" and getattr(a, "model", None) != "glimmer-local")
    paid = paid or (a.cmd == "issues" and not a.no_model)
    paid = paid or a.cmd in ("regress", "fix", "fix-any", "diary", "duo", "challenge", "hostile-judge",
                              "contract-draft", "exploit-search")
    paid = paid or (a.cmd == "reduce" and a.judge)
    paid = paid or a.cmd == "replay-check"
    paid = paid or (a.cmd == "fix-verify" and not a.dry)
    if paid:
        require_api_key()
    if a.cmd.startswith("exploit-"):
        from pt.exploit import run_cli
        return run_cli(a, ROOT)
    if a.cmd.startswith("contract-"):
        from pt.contract import run_cli
        return run_cli(a, ROOT)
    if not getattr(a, 'offline', False):
        return _main(a)
    from pt.offline import Guard
    offline = Guard()
    drivers = []
    offline.install()
    try:
        return _main(a, drivers)
    finally:
        try:
            browser = {}
            for driver in drivers:
                if hasattr(driver, 'offline_report'):
                    report = driver.offline_report()
                    browser['blocked_connections'] = browser.get('blocked_connections', 0) + report['blocked_connections']
                    browser['allowed_local_connections'] = browser.get('allowed_local_connections', 0) + report['allowed_local_connections']
                    browser['hosts'] = sorted(set(browser.get('hosts', [])) | set(report['hosts']))
            folder = Path(a.folder) if a.cmd == 'confirm' else ROOT / 'data' / 'runs' / a.name
            folder.mkdir(parents=True, exist_ok=True)
            stem = 'offline-confirm' if a.cmd == 'confirm' else 'offline'
            path = folder / f'{stem}.json'
            index = 2
            while path.exists():
                path = folder / f'{stem}-{index}.json'
                index += 1
            path.write_text(json.dumps({'python': offline.report(), 'browser': browser}, indent=1), encoding='utf-8')
        finally:
            offline.uninstall()


def _main(a, offline_drivers=None):
    sys.path.insert(0, str(ROOT))
    from pt import guard
    if a.cmd == "replay-check":
        from pt.replay_check import run_cli
        return run_cli(a)
    if a.cmd == "challenge":
        from pt.challenge import run_cli
        return run_cli(a, ROOT)
    if a.cmd in ("hostile-judge", "hostile-score"):
        from pt.hostile import run_cli
        return run_cli(a, ROOT)
    if a.cmd == "persist":
        from pt.persist import run_cli
        return run_cli(a, ROOT)
    if a.cmd == "reduce":
        from pt.reduce import run_cli
        return run_cli(a, ROOT)
    if a.cmd == "goal-clean":
        from pt.goal_clean import run_cli
        return run_cli(a, ROOT)
    if a.cmd == "goal-buggy":
        from pt.goal_buggy import run_cli
        return run_cli(a, ROOT)
    if a.cmd == "issues":
        from pt import issues
        out = Path(a.out_folder)
        if out.exists():
            print("Choose a fresh issues output folder")
            return 1
        if a.max_calls < 0:
            print("--max-calls must be zero or greater")
            return 2
        occurrences, left_out = issues.collect(a.runs)
        client = None
        if not a.no_model:
            from trials.common import load_client
            client = load_client("playtest-agent")
        groups, calls = issues.propose(occurrences, client=client, max_calls=a.max_calls)
        print(issues.write(out, groups, left_out, calls))
        return 0
    if a.cmd in ("issues-accept", "issues-split"):
        from pt import issues
        try:
            if a.cmd == "issues-accept":
                issues.accept(a.out_folder, a.group_id, a.by)
            else:
                issues.split(a.out_folder, a.group_id, a.occurrence)
        except (OSError, ValueError, KeyError) as exc:
            print(str(exc))
            return 1
        return 0
    if a.cmd == "fix":
        from pt.fix import run_cli
        return run_cli(a)
    if a.cmd == "fix-any":
        from pt.fix_any import run_cli
        return run_cli(a)
    if a.cmd == "fix-verify":
        from pt.fix_verify import run_cli
        return run_cli(a)
    if a.cmd in ("regress", "gate"):
        from pt import regress
        return regress.gate(a.folder) if a.cmd == "gate" else regress.run_cli(a, ROOT)
    if a.cmd == "guard":
        pr = guard.problems()
        print("OK" if not pr else "BLOCKED: " + "; ".join(pr))
        return 0 if not pr else 1
    if a.cmd == "report":
        from pt import report
        print(report.write(a.folder))
        return 0
    if a.cmd == "console":
        from pt import console
        print(console.write(a.folder))
        return 0
    if a.cmd == "signoff":
        return signoff(a.folder, a.by, a.note)
    if a.cmd == "verify":
        return verify(a.folder, a.digest)
    if a.cmd == "diary":
        from pt import diary
        from trials.common import load_client
        print(diary.write(a.folder, load_client("playtest-agent")))
        return 0
    if a.cmd == "deathmap":
        return deathmap_cli(a, guard)
    if a.cmd == "contrast":
        from pt.contrast import main as contrast
        return contrast(a.folder, a.game)
    problem = clean_problem(a)
    if problem:
        print(problem)
        return 2
    initial = None
    if a.cmd == "resume":
        result_path = ROOT / "data" / "runs" / a.name / "result.json"
        if not result_path.is_file():
            print("No result.json for run " + a.name)
            return 1
        initial = json.loads(result_path.read_text(encoding="utf-8"))
        a.model = a.model or initial.get("settings", {}).get("model", "wonder")
        a.game = initial.get("game_id") or initial.get("game", a.game)
        a.escalate = a.escalate or initial.get("settings", {}).get("escalate", False)
        a.checklist = a.checklist or initial.get("settings", {}).get("checklist", False) or bool(initial.get("checklist"))
        a.narrate = a.narrate or initial.get("settings", {}).get("narrate", False)
        a.vision = initial.get("settings", {}).get("vision", "normal")
    from pt.adapter import make as make_adapter
    from pt.adapter import config_path, load_config
    sam_sensors = {}
    def make(game, bugs=""):
        options = {'offline': True} if offline_drivers is not None else {}
        try:
            cfg = load_config(config_path(game))
            use_sam = bool(cfg.get("sam_player")) and not cfg.get("state_js")
        except Exception:
            use_sam = False
        if use_sam:
            driver = make_adapter(game, bugs=bugs, sam_client=client, **options)
        else:
            driver = make_adapter(game, bugs=bugs, **options)
        if getattr(driver, '_sam_sensor', None) is not None:
            driver._sam_sensor = sam_sensors.setdefault((game, bugs), driver._sam_sensor)
            _set_sam_cache_dir(driver, a)
        if offline_drivers is not None:
            offline_drivers.append(driver)
        return driver
    from trials.common import load_client, save_json
    probes = {}
    if getattr(a, 'allow_game_window', False):
        probes['games'] = lambda: []
    if getattr(a, 'allow_gpu', False):
        probes['gpu'] = lambda: 0
    if getattr(a, 'allow_comfy', False):
        probes['comfy'] = lambda: []
    bad = guard.problems(probes) if probes else guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        if a.model == "glimmer-local":
            from metaclient.local import LocalClient
            client = LocalClient(base_url=a.glimmer_url, reasoning=a.reasoning)
        else:
            client = load_client("playtest-agent")
        if a.cmd == "duo":
            from pt.duo import run_cli
            return run_cli(a, (client, load_client("playtest-agent")), offline_drivers)
        if a.cmd == "confirm":
            from pt import confirm
            game = confirm_game(a)
            options = {"judge_input": a.judge_input} if a.judge_input != "strip" else {}
            rows = confirm.confirm_run(a.folder, client, driver_cls=lambda bugs="": make(game, bugs=bugs), **options)
            for r in rows:
                print("CONFIRMED" if r["confirmed"] else ("not reproducible" if not r["reproducible"] else "not confirmed"), "|", r["title"], "|", r["evidence"][:100])
            return 0
        from pt import loop as Lp
        run = ROOT / "data" / "runs" / a.name
        run.mkdir(parents=True, exist_ok=True)
        bugs = initial.get("bugs_on", "") if initial is not None else run_settings(a, "")["bugs"]
        print("bugs on: " + (bugs or "none"))
        print("vision: " + a.vision)
        d = make(a.game, bugs=bugs)
        sink = {}
        try:
            if getattr(a, "record", False) and hasattr(d, "start_recording"):
                d.start_recording(run)
            hunt = (initial.get("kind") == "hunt") if initial is not None else a.cmd == "hunt"
            reload = hunt and callable(getattr(d, "reload", None))
            st = run_settings(a, d.goal, reload)
            if initial is not None:
                from pt.replay import restore
                restore(d, initial.get("actions_by_step", []), initial.get("steps", 0))
                st = {"goal": initial.get("goal") or (HUNT if initial.get("kind") == "hunt" else d.goal), "bugs": bugs}
            message = st["goal"]
            if initial is not None:
                message += "\nA person answered your question: " + a.note
            try:
                res = Lp.run_episode(client, d, message, max_steps=a.max_steps, max_seconds=a.max_seconds, max_usd=a.max_usd, effort=a.reasoning if a.model == "glimmer-local" else a.effort, max_out=a.max_out,
                                     on_step=lambda i, b: (run / f"s{i:03d}.jpg").write_bytes(b), label=a.name, sink=sink, observe_state=a.state,
                                     checklist=a.checklist, initial=initial, narrate=a.narrate, escalate=a.escalate,
                                     reload=reload, nudges=2 if hunt else 0, history=getattr(a, "history", "own"),
                                     summary=getattr(a, "summary", None), look_plan=getattr(a, "look_plan", False), notes=getattr(a, "notes", False), vision=a.vision,
                                     should_stop=lambda: "memory" if guard.must_stop(guard.free_gb(), guard.min_free_gb(guard.total_gb())) else None)
            except Exception as e:          # an API or network failure: keep what happened so far, and say so
                res = {**sink, "stop": "error:" + type(e).__name__, "error": str(e)[:300], "final_text": "", "seconds": 0}
            res.update({"won": bool(d.won()), "bug_hits": d.bug_hits(), "final_state": d.state(), "kind": initial.get("kind", "goal") if initial is not None else a.cmd,
                        "goal": st["goal"], "bugs_on": st["bugs"], "game": d.name, "game_id": a.game, "game_fps": getattr(d, "fps", 60),
                        "settings": {"model": a.model, "effort": a.reasoning if a.model == "glimmer-local" else a.effort, "max_out": a.max_out, "state_text": a.state, "checklist": a.checklist, "narrate": a.narrate, "escalate": a.escalate, "history": getattr(a, "history", "own"),
                                     "summary": getattr(a, "summary", None), "look_plan": getattr(a, "look_plan", False), "notes": getattr(a, "notes", False), "vision": a.vision}})
        finally:
            d.close()
        from pt.sam_sensor import add_usage
        add_usage(res, d)
        save_json(run / "result.json", {"bugs_on": res.get("bugs_on", bugs), **res})     # first line: what was planted
        if res.get("escalation"):
            save_json(run / "needs_human.json", res["escalation"])
            print("NEEDS A PERSON: " + res["escalation"]["question"])
        elif initial is not None:
            (run / "needs_human.json").unlink(missing_ok=True)
        (run / "signoff.json").unlink(missing_ok=True)
        print(json.dumps({k: res.get(k) for k in ("stop", "steps", "cost_usd", "seconds", "won")}), "reports:", len(res.get("reports", [])))
        if res["kind"] == "hunt":
            for rep in res.get("reports", []):
                print("UNVERIFIED | " + rep.get("title", ""))
            print("Run python -m pt confirm " + str(run))
        return 0
    finally:
        guard.release_lock()


if __name__ == "__main__":
    sys.exit(main())
