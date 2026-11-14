"""Repair configured source copies and check each build with a saved replay."""
import contextlib
import difflib
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from metaclient.client import output_text, wonder_cost
from metaclient.ledger import CapReached
from pt import judge, replay
from pt.fix import FORMAT, FIX_MAX_OUT, FIX_EFFORT
from pt.fix_patch import apply_edits

ROOT = Path(__file__).resolve().parents[1]


def add_parser(sub):
    parser = sub.add_parser("fix-any", help="repair a configured game copy")
    parser.add_argument("folder")
    parser.add_argument("--report", type=int, required=True)
    parser.add_argument("--fix-config", required=True)
    parser.add_argument("--tries", type=int, default=3)


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _fill(value, src, out):
    if isinstance(value, str):
        return value.replace("{src}", str(src)).replace("{out}", str(out))
    if isinstance(value, list):
        return [_fill(v, src, out) for v in value]
    if isinstance(value, dict):
        return {k: _fill(v, src, out) for k, v in value.items()}
    return value


def _driver(cfg, bugs=""):
    from pt.adapter import WebAdapter, validate
    errors = validate(cfg)
    if errors:
        raise ValueError("; ".join(errors))
    if cfg["type"] == "pcgame":
        from pt.pcgame import PcGameAdapter
        return PcGameAdapter(cfg)
    if cfg["type"] == "android":
        from pt.android import AndroidAdapter
        return AndroidAdapter(cfg)
    if cfg["type"] == "doom":
        from pt.doom import DoomAdapter
        return DoomAdapter(cfg)
    return WebAdapter(cfg, bugs=bugs)


def _inputs(run, config_path, report, tries):
    if type(tries) is not int or tries < 1:
        raise ValueError("tries must be a positive integer")
    old, cfg = _read(run / "result.json"), _read(config_path)
    settle_ms = cfg.get("replay_settle_ms", 0)
    if type(settle_ms) is not int or settle_ms < 0:
        raise ValueError("replay_settle_ms must be a nonnegative integer")
    reports = old.get("reports", [])
    if type(report) is not int or not 0 <= report < len(reports):
        raise ValueError("report must be a saved report index")
    selected = reports[report]
    confirmed = False
    confirm_path = run / "confirm.json"
    if confirm_path.is_file():
        try:
            rows = _read(confirm_path)
            row = rows[report]
            confirmed = (row.get("title") == selected.get("title") and row.get("step") == selected.get("step")
                         and row.get("confirmed") is True and row.get("status") not in ("rejected", "not compared", "input refused in replay")
                         and row.get("reproducible") is True)
        except (ValueError, TypeError, AttributeError, IndexError, KeyError):
            confirmed = False
    repeatable = False
    summary_path = run / "replay-check" / "summary.json"
    if summary_path.is_file():
        try:
            summary = _read(summary_path)
            repeatable = any(row.get("index") == report and row.get("result") == "repeatable"
                             for row in summary.get("reports", []))
        except (ValueError, TypeError, AttributeError):
            repeatable = False
    if not (confirmed or repeatable):
        raise ValueError("Report must be confirmed or repeatable before fix-any")
    actions = old.get("actions_by_step")
    if (not isinstance(actions, list) or type(selected.get("step")) is not int
            or not 0 <= selected["step"] <= len(actions)):
        raise ValueError("Report needs a step within the saved actions")
    if settle_ms > 0:
        replay_actions = list(actions)
        if selected["step"] > 0:
            replay_actions[selected["step"] - 1] = [
                *replay_actions[selected["step"] - 1], {"type": "wait", "ms": settle_ms}]
    else:
        replay_actions = actions
    source = (ROOT / cfg["source"]).resolve(strict=True)
    if not source.is_dir():
        raise ValueError("source must be a folder")
    editable = cfg["editable"]
    if not isinstance(editable, list) or not editable or len(set(editable)) != len(editable):
        raise ValueError("editable must list distinct files")
    for name in editable:
        path = source / name
        if (Path(name).is_absolute() or ".." in Path(name).parts
                or not path.resolve(strict=True).is_relative_to(source) or not path.is_file()):
            raise ValueError("editable path must be a file inside source")
    # Copies must not follow links to files outside the configured source.
    for path in source.rglob("*"):
        if path.is_symlink() or path.is_junction():
            raise ValueError("source must not contain links")
    if not isinstance(cfg.get("checks"), list) or not cfg["checks"]:
        raise ValueError("checks must contain at least one command")
    for command in [cfg["build"], *cfg["checks"]]:
        if not isinstance(command, list) or not command or not all(isinstance(v, str) for v in command):
            raise ValueError("Commands must be nonempty lists of strings")
    if not isinstance(cfg["game"], dict) or not isinstance(cfg["context"], list):
        raise ValueError("game must be an object and context must be a list")
    for name in cfg["context"]:
        if (ROOT / name).resolve(strict=True).is_relative_to(source):
            raise ValueError("Read only context must be outside the copied source")
    if "mod" in cfg:
        from pt.fix_mod import validate
        validate(cfg)
    return old, selected, cfg, source, ("repeatable" if repeatable else "confirmed"), replay_actions


def _proposal(client, sources, contexts, report, failure, name, label, instructions=""):
    prompt = ("Repair the reported game behavior while preserving the rest of the game. "
              "Do not hide the symptom, disable the game or fake success. "
              "Return exact search and replace edits for only the target file " + name + ". "
              "Return diff as an empty string. Use edits=[] to leave this file alone. "
              "Do not put read only context text in edits, diff or why.\n"
              + instructions + "\nReport:\n"
              + json.dumps(report, ensure_ascii=False)
              + "\nPrevious attempt failure: " + (failure or "None")
              + "\nEditable original files:\n" + json.dumps(sources, ensure_ascii=False)
              + "\nRead only context:\n" + json.dumps(contexts, ensure_ascii=False))
    body = {"input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            "max_output_tokens": FIX_MAX_OUT, "reasoning": {"effort": FIX_EFFORT},
            "text": {"format": FORMAT}}
    return client.wonder(body, label=label,
                         reserve_usd=wonder_cost(len(prompt.encode("utf-8")) + 1000, FIX_MAX_OUT) + .005)


def _command(command, runner):
    process = None
    try:
        if runner is subprocess.run:
            process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True,
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
            try:
                stdout, stderr = process.communicate(timeout=_command.timeout)
            except subprocess.TimeoutExpired:
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, check=False)
                process.kill()
                stdout, stderr = process.communicate()
                return {"command": command, "returncode": None, "stdout": stdout or "",
                        "stderr": "Build timed out"}
            result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        else:
            result = runner(command, cwd=ROOT, capture_output=True, text=True, check=False,
                            timeout=_command.timeout)
        return {"command": command, "returncode": result.returncode,
                "stdout": result.stdout or "", "stderr": result.stderr or ""}
    except subprocess.TimeoutExpired as exc:
        if process is not None:
            pid = process.pid
        else:
            pid = getattr(exc, "pid", None)
        if pid:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, check=False)
        return {"command": command, "returncode": None, "stdout": "", "stderr": "Build timed out"}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"command": command, "returncode": None, "stdout": "", "stderr": str(exc)}


_command.timeout = 600


class _JudgeClient:
    """Retain the full verdict in memory while using the normal client ledger."""
    def __init__(self, client):
        self.client = client
        self.reasoning = getattr(client, "reasoning", "low")
        self.text = ""

    def responses(self, *args, **kwargs):
        response = self.client.responses(*args, **kwargs)
        self.text = output_text(response)
        return response


def fix_run(run_dir, client, *, report, fix_config, tries=3,
            runner=subprocess.run, driver_factory=None):
    """Use the supplied ledger client; keep context and build copies off disk artifacts."""
    run = Path(run_dir).resolve()
    old, selected, cfg, source, confirmation, replay_actions = _inputs(run, fix_config, report, tries)
    dest = run / f"fix-any-{report}.json"
    diff_path = dest.with_suffix(".diff")
    if dest.exists() or diff_path.exists():
        raise ValueError("Choose a report without existing fix-any results")
    contexts, metadata = {}, []
    for name in cfg["context"]:
        path = (ROOT / name).resolve(strict=True)
        data = path.read_bytes()
        contexts[str(path)] = data.decode("utf-8-sig")
        metadata.append({"path": str(path), "sha256": hashlib.sha256(data).hexdigest()})
    sources = {name: (source / name).read_text(encoding="utf-8") for name in cfg["editable"]}
    # Shared syntax in the editable input, such as a closing brace, is already
    # public input. Keep it usable while blocking the distinct context lines.
    private = sorted({part for text in contexts.values()
                      for part in [text, *(line.rstrip() for line in text.splitlines()
                                           if len(line.strip()) >= 40
                                           and not line.strip().startswith(("using ", "namespace ")))]
                      if part.strip()
                      and (part == text or not any(part in original for original in sources.values()))},
                     key=len, reverse=True)
    for path in source.rglob("*"):
        if path.is_file():
            data = path.read_bytes()
            if any(text.encode("utf-8") in data for text in private):
                raise ValueError("Copied source must not contain read only context")

    def clean(value):
        if isinstance(value, str):
            for text in private:
                for encoded in (text, json.dumps(text, ensure_ascii=False)[1:-1],
                                json.dumps(text, ensure_ascii=True)[1:-1]):
                    value = value.replace(encoded, "[private context]")
            return value
        if isinstance(value, list):
            return [clean(v) for v in value]
        if isinstance(value, dict):
            return {clean(k): clean(v) for k, v in value.items()}
        return value

    result = {"report_index": report, "confirmation": confirmation, "context": metadata, "attempts": [],
              "result": "not fixed", "cost_usd": 0.0}
    failure, final_diff = "", ""
    factory = driver_factory or _driver
    temporary_parent = None
    if "mod" in cfg:
        from pt import fix_mod
        temporary_parent = fix_mod.work_folder(cfg)
    # Third party drivers may print. Never forward their output or model responses.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        for attempt in range(1, tries + 1):
            row = {"try": attempt, "edits": {}, "why": {}, "build": None,
                   "judge": None, "checks": [], "cost_usd": 0.0, "failure": ""}
            if cfg.get("replay_settle_ms", 0) > 0:
                row["replay_settle_ms"] = cfg["replay_settle_ms"]
            result["attempts"].append(row)
            ledger = getattr(client, "ledger", None)
            spent_before = ledger.spent() if ledger is not None else None
            _command.timeout = cfg.get("build_timeout_s", 600)
            final_diff = ""
            with tempfile.TemporaryDirectory(prefix="pt-fix-any-", dir=temporary_parent,
                    ignore_cleanup_errors=True) as temporary, contextlib.ExitStack() as cleanup:
                src, out = Path(temporary) / "source", Path(temporary) / "out"
                shutil.copytree(source, src)
                out.mkdir()
                try:
                    changed = False
                    for name, original in sources.items():
                        response = _proposal(client, sources, contexts, selected, failure, name,
                                             f"{run.name}:fix-any:{report}:try{attempt}:{name}",
                                             cfg.get("repair_instructions", ""))
                        row["cost_usd"] += response["_cost_usd"]
                        try:
                            if response.get("status") == "incomplete":
                                raise ValueError("Incomplete patch response")
                            patch = json.loads(output_text(response))
                            if (not isinstance(patch, dict) or set(patch) != {"edits", "diff", "why"}
                                    or patch["diff"] != "" or not isinstance(patch["edits"], list)
                                    or not isinstance(patch["why"], str)):
                                raise ValueError("Use search and replace edits for the target file only")
                            row["edits"][name], row["why"][name] = patch["edits"], patch["why"]
                            updated = apply_edits(original, patch["edits"]) if patch["edits"] else original
                            if any(text in updated for text in private):
                                raise ValueError("Patch contains read only context")
                            (src / name).write_text(updated, encoding="utf-8", newline="\n")
                            changed |= updated != original
                            final_diff += "".join(difflib.unified_diff(original.splitlines(True),
                                updated.splitlines(True), fromfile="a/" + name, tofile="b/" + name))
                        except (ValueError, TypeError) as exc:
                            raise ValueError("Patch rejected: " + str(exc)) from None
                    if not changed:
                        raise ValueError("Patch rejected: no files changed")
                    row["build"] = _command(_fill(cfg["build"], src, out), runner)
                    if row["build"]["returncode"] != 0:
                        raise ValueError("Build failed: " + json.dumps(row["build"]))
                    game = _fill(cfg["game"], src, out)
                    health_seen = []
                    def tracked_driver(bugs=""):
                        driver = factory(game, bugs=bugs)
                        class Tracker:
                            def __getattr__(self, key): return getattr(driver, key)
                            def execute(self, actions):
                                driver.execute(actions)
                                if hasattr(driver, "health"):
                                    health_seen.append(driver.health())
                        return Tracker()
                    def checked_trace():
                        health_seen.clear()
                        trace = replay.replay_trace(replay_actions, selected["step"],
                            old.get("bugs_on", ""), driver_cls=tracked_driver)
                        states = trace["states"]
                        if (not trace.get("frames") or not states or
                                len(old["actions_by_step"][:selected["step"]]) != selected["step"]):
                            raise ValueError("the replay did not reach the report")
                        from PIL import Image
                        frame = Image.open(io.BytesIO(trace["frames"][-1])).convert("RGB")
                        if len(set(frame.getdata())) <= 1:
                            raise ValueError("the replay did not reach the report")
                        if health_seen:
                            health = health_seen[-1]
                            if health is False or (isinstance(health, dict) and health.get("alive") is False):
                                raise ValueError("the replay did not reach the report")
                        return trace
                    if "mod" in cfg:
                        fix_mod.validate(cfg)
                        control = checked_trace()
                        command = _fill(cfg["replay_check"], src, out)
                        row["control"] = fix_mod.picture_check(command, control, temporary,
                                                              lambda cmd: _command(cmd, runner))
                        if row["control"]["returncode"] != 1:
                            raise ValueError("Control check must fail with exit code 1 with the fix off")
                        cleanup.enter_context(fix_mod.installed(cfg, out))
                    trace = checked_trace()
                    states = trace["states"]
                    if "mod" in cfg:
                        row["replay_check"] = fix_mod.picture_check(command, trace, temporary,
                                                                   lambda cmd: _command(cmd, runner))
                        if row["replay_check"]["returncode"] != 0:
                            raise ValueError("Replay check failed with the fix on")
                    judge_client = _JudgeClient(client)
                    verdict = judge.judge(judge_client, selected, trace["frames"],
                        judge.state_diff(states[0], states[-1]),
                        label=f"{run.name}:fix-any:{report}:judge{attempt}")
                    try:
                        answer = json.loads(judge_client.text).get("verdict", "").strip().upper()
                    except (ValueError, AttributeError):
                        answer = ""
                    row["judge"] = {"verdict": answer, "reason": verdict["evidence"],
                                    "incomplete": verdict["incomplete"]}
                    if spent_before is None:
                        row["cost_usd"] += verdict["cost_usd"]
                    if answer != "NO" or verdict["incomplete"] or not verdict["evidence"].strip():
                        raise ValueError("Bug remains or judge gave no NO verdict: " + (verdict["evidence"].strip() or "no evidence"))
                    for command in cfg["checks"]:
                        check = _command(_fill(command, src, out), runner)
                        row["checks"].append(check)
                        if check["returncode"] != 0:
                            raise ValueError("Check failed: " + json.dumps(check))
                    result["result"] = "fixed"
                except CapReached:
                    raise
                except Exception as exc:
                    row["failure"] = clean(str(exc))
                finally:
                    if spent_before is not None:
                        row["cost_usd"] = ledger.spent() - spent_before
            result["cost_usd"] += row["cost_usd"]
            failure = row["failure"]
            if result["result"] != "fixed":
                builds = [r["build"] for r in result["attempts"]]
                result["result"] = ("build failed" if all(b is not None and b["returncode"] != 0
                                                         for b in builds) else "not fixed")
            dest.write_text(json.dumps(clean(result), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
            diff_path.write_text(clean(final_diff), encoding="utf-8", newline="\n")
            if result["result"] == "fixed":
                break
    return clean(result)


def run_cli(args):
    from pt import guard
    from trials.common import load_client
    bad = guard.problems()
    if bad:
        print("BLOCKED, no game started: " + "; ".join(bad))
        return 1
    _inputs(Path(args.folder), args.fix_config, args.report, args.tries)
    guard.take_lock()
    try:
        result = fix_run(args.folder, load_client("playtest-agent"), report=args.report,
                         fix_config=args.fix_config, tries=args.tries)
        print(result["result"])
        return 0 if result["result"] == "fixed" else 1
    finally:
        guard.release_lock()
