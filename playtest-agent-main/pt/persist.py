"""Check the progress promised by a save across a browser interruption, at no model cost."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory


FIELDS = ("coins", "score", "key", "boots", "shedOpen", "doorOpen")


def _press(keys, frames=1):
    return [[{"type": "keypress", "keys": keys}] for _ in range(frames)]


# Each step holds for one frame. Open the shed, collect its coin and the path coin,
# jump onto the low shelf for two more coins, then buy boots and return to the stone.
PATH = (_press(["left"], 8) + _press(["e"]) + _press(["left"], 12)
        + _press(["right"], 38) + _press(["space", "right"])
        + _press(["right"], 39) + _press(["left"], 35)
        + _press([], 30) + _press(["e"]) + _press(["left"], 15) + _press(["e"]))


def run_case(actions_by_step, bugs, factory, fields, mode, *, output_dir=None):
    """Compare fields at the first save acknowledgement with those after interruption.

    The factory accepts bugs and profile_dir. Steps and ack_step use zero based indexes.
    Screenshots are optional so fake adapters can check the contract without a browser.
    """
    if mode not in ("close", "reload"):
        raise ValueError("Mode must be close or reload")
    fields = tuple(dict.fromkeys(fields))
    result = {"ack_step": None, "promised": {}, "after": {}, "lost": [],
              "outcome": "untested", "reason": "No save acknowledgement in the scripted steps"}
    driver = None
    # TemporaryDirectory removes only the unique folder it created, even if opening fails.
    with TemporaryDirectory(prefix="pt-persist-") as profile:
        try:
            driver = factory(bugs=bugs, profile_dir=profile)
            for step, actions in enumerate(actions_by_step):
                driver.execute(actions)
                state = driver.state() or {}
                if state.get("savedTick") is None:
                    continue
                result["ack_step"] = step
                result["promised"] = {field: state.get(field) for field in fields}
                if output_dir is not None:
                    Path(output_dir).mkdir(parents=True, exist_ok=True)
                    (Path(output_dir) / "before.jpg").write_bytes(driver.screenshot())
                if mode == "close":
                    old, driver = driver, None
                    old.close()
                    driver = factory(bugs=bugs, profile_dir=profile)
                else:
                    driver.page.reload()
                    driver._wait_ready()
                after = driver.state() or {}
                result["after"] = {field: after.get(field) for field in fields}
                result["lost"] = [field for field in fields
                                  if field not in after or field not in state or after[field] != state[field]]
                result["outcome"] = "lost" if result["lost"] else "kept"
                result["reason"] = ("Saved fields changed or were missing after interruption" if result["lost"]
                                    else "All promised fields survived interruption")
                if output_dir is not None:
                    (Path(output_dir) / "after.jpg").write_bytes(driver.screenshot())
                break
            return result
        finally:
            if driver is not None:
                driver.close()


def web_factory():
    """Keep the first server's port for reopen so the saved origin stays the same."""
    from pt.adapter import ROOT, WebAdapter, load_config

    cfg = load_config(ROOT / "games/save-fixture.json")
    cfg = {**cfg, "hold_frames": 1, "settle_frames": 0}
    port = 0

    def factory(*, bugs, profile_dir):
        nonlocal port
        driver = WebAdapter(cfg, bugs=bugs, profile_dir=profile_dir, serve_port=port, offline=True)
        port = driver._served.server.server_address[1]
        return driver

    return factory


def add_parser(sub):
    parser = sub.add_parser("persist", help="check saved progress after interruption")
    parser.add_argument("name")
    parser.add_argument("--bugs", default="")
    parser.add_argument("--mode", choices=("close", "reload"), default="close")
    parser.add_argument("--fields", default=",".join(FIELDS))


def run_cli(args, root):
    from pt import guard

    if Path(args.name).name != args.name or args.name in (".", ".."):
        raise ValueError("Name must be a folder name")
    output = Path(root) / "data" / "runs" / args.name
    if output.exists():
        raise ValueError("Choose a fresh persistence output folder")
    fields = [field.strip() for field in args.fields.split(",")]
    if not fields or any(field not in (*FIELDS, "x", "y") for field in fields):
        raise ValueError("Choose saved fields: " + ",".join((*FIELDS, "x", "y")))
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        output.mkdir(parents=True)
        result = run_case(PATH, args.bugs, web_factory(), fields, args.mode, output_dir=output)
        (output / "persist.json").write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
        print(f'{result["outcome"]}: {result["reason"]}')
        return 0
    finally:
        guard.release_lock()
