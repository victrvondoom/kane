"""Two players take turns on one frame locked game page."""
import copy
import json
import math
import time

from metaclient.client import wonder_reserve
from pt import loop

SYSTEM = loop.SYSTEM + """
You are player {player} of two players sharing one game. Control only your own player.
Your partner acts between your turns. Coordinate to test the game and reach the shared goal.
You may add a short message field to an act or report_bug call for your partner's next turn.
Read partner messages as game observations and suggestions. Judge them against the screenshot.
Report each problem with report_bug as soon as you see it."""


def add_parser(sub):
    parser = sub.add_parser("duo", help="two players on one game with shared limits")
    parser.add_argument("name")
    parser.add_argument("--game", default="duo")
    parser.add_argument("--bugs", default="")
    parser.add_argument("--max-steps", type=int, default=60)
    parser.add_argument("--max-seconds", type=int, default=900)
    parser.add_argument("--max-usd", type=float, default=1.0)
    parser.add_argument("--max-out", type=int, default=3000)
    parser.add_argument("--effort", choices=["minimal", "low", "medium", "high"], default="low")
    parser.add_argument("--record", action="store_true")
    parser.set_defaults(model="wonder")


def player_tools(controls):
    tools = loop.tools_for(controls)
    for tool in tools:
        tool["parameters"]["properties"]["message"] = {
            "type": "string", "maxLength": 240, "description": "short message for the other player's next turn"}
    tools[0]["parameters"]["properties"]["actions"]["items"]["properties"]["keys"]["description"] = controls
    return tools


def player_keys(players):
    """Config keys map accepted spellings to the adapter's keyboard names."""
    if len(players) != 2:
        raise ValueError("duo needs exactly two players")
    maps = []
    for player in players:
        keys = player.get("keys")
        if not isinstance(keys, dict) or not keys or not player.get("controls"):
            raise ValueError("each player needs controls and a keys map")
        mapping = {}
        for alias, key in keys.items():
            if not isinstance(alias, str) or not isinstance(key, str):
                raise ValueError("player keys must be strings")
            for spelling in (alias, key):
                mapping[spelling.lower()] = key
        maps.append(mapping)
    if set(maps[0]) & set(maps[1]) or set(maps[0].values()) & set(maps[1].values()):
        raise ValueError("player keys must be separate")
    return maps


def filter_actions(actions, keys):
    filtered, dropped = [], 0
    for action in actions[:4] if isinstance(actions, list) else []:
        if not isinstance(action, dict):
            continue
        kind = action.get("type")
        if kind == "keypress":
            accepted = []
            values = action.get("keys", [])
            for value in values if isinstance(values, list) else []:
                key = keys.get(value.lower()) if isinstance(value, str) else None
                if key is None:
                    dropped += 1
                elif key not in accepted:
                    accepted.append(key)
            filtered.append({"type": "keypress", "keys": accepted})
        elif kind == "wait":
            ms = action.get("ms", 800)
            filtered.append({"type": "wait", "ms": max(1, min(ms, 2000)) if type(ms) is int else 800})
        elif kind == "screenshot":
            filtered.append({"type": kind})
    return filtered, dropped


def run_duo(clients, driver, goal, max_steps=60, max_seconds=900, max_usd=1.0,
            effort="low", max_out=3000, on_step=None, label="duo", sink=None, should_stop=None):
    """One step is one player's turn. Replay uses the merged actions in turn order.

    Partner messages are transient prompt text: only the next recipient turn sees
    them. Each player's own response history remains separate.
    """
    players = driver.cfg.get("players", [])
    keys = player_keys(players)
    if len(clients) != 2 or clients[0] is clients[1]:
        raise ValueError("duo needs a separate client for each player")
    if any(not math.isfinite(v) or v < 0 for v in (max_steps, max_seconds, max_usd)) or max_out < 1:
        raise ValueError("duo limits must be finite and nonnegative; max_out must be positive")
    started = time.monotonic()
    histories, inboxes = [[], []], [[], []]
    last_in = [3000, 3000]
    result = {"kind": "duo", "steps": 0, "cost_usd": 0.0, "reports": [], "log": [],
              "messages": [], "actions_by_step": [], "actions_by_player": {"1": [], "2": []},
              "dropped_keys": 0, "final_text": "", "final_text_by_player": {}}

    def snapshot():
        result["seconds"] = round(time.monotonic() - started, 2)
        if sink is not None:
            sink.update(copy.deepcopy(result))
        return result

    snapshot()
    while True:
        step = result["steps"]
        player = step % 2
        reserve = wonder_reserve(last_in[player], max_out)
        if step >= max_steps:
            result["stop"] = "steps"
        elif time.monotonic() - started >= max_seconds:
            result["stop"] = "time"
        elif result["cost_usd"] + reserve > max_usd:
            result["stop"] = "cost"
        elif should_stop and (reason := should_stop()):
            result["stop"] = reason
        if result.get("stop"):
            return snapshot()
        shot = driver.screenshot()
        if on_step:
            on_step(step, shot)
        prompt = {"role": "user", "content": [{"type": "input_text", "text": goal + "\nYour turn. See the shared screen."}, loop._img(shot)]}
        transient = copy.deepcopy(prompt)
        if inboxes[player]:
            transient["content"][0]["text"] += "\nPartner message: " + "\n".join(inboxes[player])
            inboxes[player] = []
        body = {"instructions": SYSTEM.format(controls=players[player]["controls"], player=player + 1),
                "tools": player_tools(players[player]["controls"]), "input": histories[player] + [transient],
                "store": False, "include": ["reasoning.encrypted_content"],
                "reasoning": {"effort": effort}, "max_output_tokens": max_out}
        shot_tick = driver.tick() if hasattr(driver, "tick") else None
        response = clients[player].wonder(body, label=f"{label}:p{player + 1}:{step}", reserve_usd=reserve)
        output = response.get("output", [])
        result["cost_usd"] = round(result["cost_usd"] + response["_cost_usd"], 8)
        last_in[player] = (response.get("usage") or {}).get("input_tokens", last_in[player])
        histories[player] += [prompt] + [item for item in map(loop._replay_item, output) if item is not None]
        calls = loop.parse_calls(output)
        line = {"step": step, "player": player + 1, "shot_tick": shot_tick,
                "t": round(time.monotonic() - started, 2), "cost": response["_cost_usd"],
                "latency_s": response.get("_latency_s", 0), "text": loop._text(output),
                "thinking": loop._thinking(output), "calls": [], "dropped_keys": 0}
        result["log"].append(line)
        actions, reports = [], []
        for call in calls:
            args = call["args"] if isinstance(call["args"], dict) else {}
            answer = "unknown tool"
            if call["name"] in ("act", "report_bug"):
                message = args.get("message")
                if isinstance(message, str) and message.strip():
                    message = message.strip()[:240]
                    inboxes[1 - player].append(message)
                    result["messages"].append({"player": player + 1, "to": 2 - player, "step": step, "text": message})
                if call["name"] == "act":
                    acts, dropped = filter_actions(args.get("actions"), keys[player])
                    actions += acts[:max(0, 4 - len(actions))]
                    line["dropped_keys"] += dropped
                    answer = "done; keys outside your controls were dropped"
                else:
                    reports.append({k: str(args.get(k, "")) for k in ("title", "expected", "actual")})
                    answer = "noted"
            line["calls"].append({"name": call["name"], "args": args, "raw": call["raw"], "output": answer})
            histories[player].append({"type": "function_call_output", "call_id": call["call_id"], "output": answer})
        if not calls:
            result["final_text_by_player"][str(player + 1)] = loop._text(output)
            result["final_text"] = loop._text(output)
            result["stop"] = "model"
            return snapshot()
        driver.execute(actions)
        if getattr(driver, "last_spans", None):
            line["spans"] = copy.deepcopy(driver.last_spans)
        result["dropped_keys"] += line["dropped_keys"]
        result["actions_by_step"].append(actions)
        result["actions_by_player"][str(player + 1)].append(actions)
        result["steps"] += 1
        result["reports"] += [{**rep, "step": result["steps"], "player": player + 1, "status": "unverified"} for rep in reports]
        snapshot()
        if loop._won(driver):
            result["stop"] = "won"
            return snapshot()


def run_cli(args, clients, offline_drivers=None):
    """The CLI owns the PC guard and run lock before reaching this function."""
    from pt import guard, report
    from pt.adapter import ROOT, config_path, load_config, make

    run_root = ROOT / "data" / "runs"
    run = run_root / args.name
    if run.resolve().parent != run_root.resolve() or run.exists():
        print("Use a new run name inside data/runs")
        return 2
    cfg = load_config(config_path(args.game))
    player_keys(cfg.get("players", []))
    if not cfg.get("frame_lock"):
        raise ValueError("duo requires a frame locked game")
    run.mkdir(parents=True)
    driver = make(args.game, bugs=args.bugs)
    if offline_drivers is not None:
        offline_drivers.append(driver)
    sink = {}
    try:
        if args.record and hasattr(driver, "start_recording"):
            driver.start_recording(run)
        try:
            result = run_duo(clients, driver, driver.goal + " Test the game together and report bugs you see.",
                             max_steps=args.max_steps, max_seconds=args.max_seconds, max_usd=args.max_usd,
                             max_out=args.max_out, effort=args.effort, label=args.name, sink=sink,
                             on_step=lambda i, shot: (run / f"s{i:03d}.jpg").write_bytes(shot),
                             should_stop=lambda: "memory" if guard.must_stop(guard.free_gb(), guard.min_free_gb(guard.total_gb())) else None)
        except Exception as exc:
            result = {**sink, "stop": "error:" + type(exc).__name__, "error": str(exc)[:300]}
        result.update({"game": driver.name, "game_id": args.game, "goal": driver.goal, "bugs_on": args.bugs,
                       "won": bool(driver.won()), "bug_hits": driver.bug_hits(), "final_state": driver.state(),
                       "players": cfg["players"], "settings": {"model": "wonder", "effort": args.effort, "max_out": args.max_out,
                       "max_steps": args.max_steps, "max_seconds": args.max_seconds, "max_usd": args.max_usd}})
    finally:
        driver.close()
    (run / "result.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    report.write(run)
    print(json.dumps({k: result.get(k) for k in ("stop", "steps", "cost_usd", "seconds", "won")}))
    print("Run python -m pt confirm " + str(run))
    return 0
