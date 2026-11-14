"""The playing loop: Muse Wonder sees a screenshot, calls `act` with actions or `report_bug`, the harness runs them and sends a new screenshot.
Wonder's native computer tool was refused for this key (HTTP 400), so actions travel through a plain function tool (docs/PLAN.md, Amendment 1)."""
import base64
import copy
import json
import time

from metaclient.client import ApiError, wonder_reserve
from pt.vision import MODES, REPORT_NOTE, filter_screenshot

TOOLS = [
    {"type": "function", "name": "act", "description": "Run a short batch of actions in the game, then get a new screenshot. Use one action when the next step depends on what happens.",
     "parameters": {"type": "object", "properties": {"actions": {"type": "array", "items": {"type": "object", "properties": {
         "type": {"type": "string", "enum": ["keypress", "wait", "screenshot"]},
         "keys": {"type": "array", "items": {"type": "string"}, "description": "keys pressed together and held 250 ms: left, right, space, e, r"},
         "ms": {"type": "integer"}}, "required": ["type"]}}}, "required": ["actions"]}},
    {"type": "function", "name": "report_bug", "description": "File a bug you just saw. Say what you expected, and what you saw.",
     "parameters": {"type": "object", "properties": {"title": {"type": "string"}, "expected": {"type": "string"}, "actual": {"type": "string"}},
                    "required": ["title", "expected", "actual"]}},
]

ESCALATE_TOOL = {"type": "function", "name": "escalate", "description": "Stop and ask a person for help.",
                 "parameters": {"type": "object", "properties": {"reason": {"type": "string"}, "question": {"type": "string"}},
                                "required": ["reason", "question"]}}

CHECKLIST_TOOLS = [
    {"type": "function", "name": "set_checklist", "description": "Write the checks you must finish. Replaces the current list.",
     "parameters": {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "string"}}}, "required": ["items"]}},
    {"type": "function", "name": "tick", "description": "Finish a checklist item. The first index is 0. Give evidence.",
     "parameters": {"type": "object", "properties": {"index": {"type": "integer"}, "evidence": {"type": "string"}}, "required": ["index", "evidence"]}},
]

SYSTEM = """You are testing a game in a browser. You see screenshots and choose actions with the `act` tool.
Controls: {controls}
A key press holds the key (or keys, pressed together) for a quarter of a second.
Send up to 4 actions in one call when you do not need to see the screen between them (for example a few steps of walking). Send one action when the next move depends on what happens. Look at each new screenshot before you decide.
When you are done, reply with a normal message and no tool call.
Do not claim something happened unless the screenshot shows it."""


RELOAD_NOTE = (" The reload action starts the game again from its first screen, as if you closed it and opened it."
               " Use it only when you are stuck and the game's own controls cannot get you out.")

LOOK_PLAN = ("\nIn every act call, fill look first, then plan, then actions."
             " look: what you see on the screen now, and what changed since the last screenshot."
             " plan: your plan for the next few moves, and why.")

NOTES = (" notes: your explore notes, copied from your last act call and updated: the places you have seen,"
         " the doors and things you have tried, and the next place you have not explored yet.")

NOTES_FIELD = {"notes": {"type": "string", "description": "places seen, doors and things tried, and the next place not explored yet; copy your last notes and update them"}}

LOOK_PLAN_FIELDS = {"look": {"type": "string", "description": "what you see on the screen now, and what changed since the last screenshot"},
                    "plan": {"type": "string", "description": "your plan for the next few moves, and why"}}

NUDGE = ("You still have {left} steps. Do not stop yet. Think of what you saw but have not tested, and test it now."
         "{reload}")


def tools_for(controls, checklist=False, escalate=False, reload=False, look_plan=False, notes=False):
    """Offer pointer actions when the controls mention them."""
    t = copy.deepcopy(TOOLS)
    if look_plan or notes:
        params = t[0]["parameters"]
        fields = {**(LOOK_PLAN_FIELDS if look_plan else {}), **(NOTES_FIELD if notes else {})}
        params["properties"] = {**copy.deepcopy(fields), **params["properties"]}
        params["required"] = list(fields) + params["required"]
    if reload:
        t[0]["parameters"]["properties"]["actions"]["items"]["properties"]["type"]["enum"].append("reload")
        t[0]["description"] += RELOAD_NOTE
    if checklist:
        t += copy.deepcopy(CHECKLIST_TOOLS)
    if escalate:
        t.append(copy.deepcopy(ESCALATE_TOOL))
    controls = (controls or "").lower()
    item = t[0]["parameters"]["properties"]["actions"]["items"]
    if "click" in controls:
        item["properties"]["type"]["enum"].append("click")
    if "click" in controls or "swipe" in controls:
        item["properties"]["x"] = {"type": "integer", "description": "click x in screenshot pixels"}
        item["properties"]["y"] = {"type": "integer", "description": "click y in screenshot pixels"}
    if "swipe" in controls:
        item["properties"]["type"]["enum"].append("swipe")
        item["properties"]["x"]["description"] = "start x in screenshot pixels"
        item["properties"]["y"]["description"] = "start y in screenshot pixels"
        item["properties"]["x2"] = {"type": "integer", "description": "end x in screenshot pixels"}
        item["properties"]["y2"] = {"type": "integer", "description": "end y in screenshot pixels"}
    return t


def _state_line(driver, on):
    """The game's own state as text, only when the run asks for it and the game gives one. Never includes a won flag the agent could read as the answer."""
    if not on:
        return ""
    st = driver.state() if hasattr(driver, "state") else None
    if not isinstance(st, dict):
        return ""
    st = {k: v for k, v in st.items() if k != "won"}
    return chr(10) + "State: " + json.dumps(st) if st else ""


def _won(driver):
    w = getattr(driver, "won", None)
    if callable(w):
        v = w()
        if v is not None:
            return bool(v)
    return bool((driver.state() or {}).get("won"))


def parse_calls(output):
    calls = []
    for it in output or []:
        if it.get("type") == "function_call":
            try:
                args = json.loads(it.get("arguments") or "{}")
            except ValueError:
                args = {}
            calls.append({"name": it.get("name"), "call_id": it.get("call_id"), "args": args, "raw": it.get("arguments") or ""})
    return calls


def _text(output):
    parts = []
    for it in output or []:
        if it.get("type") == "message":
            for c in it.get("content") or []:
                if isinstance(c.get("text"), str):
                    parts.append(c["text"])
    return "".join(parts)


def _thinking(output):
    """The readable summary of the model's reasoning, when the request asked for one and the model wrote one."""
    return " ".join(s.get("text", "") for it in output or [] if it.get("type") == "reasoning"
                    for s in it.get("summary") or [] if isinstance(s, dict)).strip()


def _replay_item(it):
    """One output item as it goes back in an own history call: reasoning only with its encrypted content, commentary keeps its phase."""
    kind = it.get("type")
    if kind == "function_call":
        return {k: it[k] for k in ("type", "call_id", "name", "arguments") if k in it}
    if kind == "message":
        msg = {"role": "assistant", "content": it.get("content")}
        if it.get("phase"):
            msg["phase"] = it["phase"]
        return msg
    if kind == "reasoning" and it.get("encrypted_content"):
        return {"type": "reasoning", "summary": [], "encrypted_content": it["encrypted_content"]}
    return None


def _size_note(driver, shot):
    """Pointer games: tell the model how big the screenshot is, so its x and y match the picture."""
    controls = (getattr(driver, "controls", "") or "").lower()
    if "click" not in controls and "swipe" not in controls:
        return ""
    try:
        import io
        from PIL import Image
        w, h = Image.open(io.BytesIO(shot)).size
    except Exception:
        return ""
    return f" Screenshot size: {w} by {h} pixels. Give x and y in these pixels, with 0,0 at the top left."


def _img(png_or_jpg):
    return {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(png_or_jpg).decode()}


def run_episode(client, driver, goal, max_steps=60, max_seconds=300, max_usd=2.5, effort="low", max_out=3000, on_step=None, label="play", system=SYSTEM, sink=None, should_stop=None, observe_state=False, checklist=False, initial=None, escalate=False, narrate=False, reload=False, nudges=0, history="own", summary=None, look_plan=False, notes=False, vision="normal"):
    """history "own": every call sends the whole turn list (store off). "server": calls point at the stored chain by
    previous_response_id. Saved runs: chain calls waited a median of 10 to 16 s, the same runs after their fallback to
    their own history 1.5 to 3 s, for the same input tokens (docs/RESULTS.md, step speed). An own history call also sends
    back the model's encrypted reasoning, so its thinking carries over (Meta's Responses guide, reasoning items).
    summary: ask for a readable summary of the reasoning ("auto", "concise" or "detailed"); it is logged as "thinking".
    look_plan: ask for LOOK and PLAN lines before every act call.
    notes: a required notes field in every act call, carried from move to move (docs/DOOM-LOST.md)."""
    t0 = time.time()
    if vision not in MODES:
        raise ValueError("Unknown vision mode: " + str(vision))
    if hasattr(driver, "set_recording_vision"):
        driver.set_recording_vision(vision)
    system = system.format(controls=getattr(driver, "controls", "") or "keyboard")
    if vision != "normal":
        system += REPORT_NOTE
    if look_plan:
        system += LOOK_PLAN
    if notes:
        system += "\nIn every act call, also fill notes." + NOTES
    if narrate:
        system += "\nBefore each action, say one short sentence about what you see and what you will try."
    if checklist:
        system += "\nWrite a short checklist of what you must try or prove before you act, then tick items as you finish them."
    cost, prev, last_in = 0.0, None, 3000
    final_text, stop = "", None
    initial = copy.deepcopy(initial or {})
    reports, by_step, log = (initial.get(k, []) for k in ("reports", "actions_by_step", "log"))
    items = initial.get("checklist", [])
    prior_items = len(items)
    if checklist and items:
        system += "\nChecklist so far: " + json.dumps(items) + "\nKeep these items. New checklist items follow them. Tick uses the index in the full list."
    steps = start_step = initial.get("steps", len(by_step))
    prior_cost, prior_seconds = initial.get("cost_usd", 0), initial.get("seconds", 0)
    escalation = None
    nudged = 0

    def snapshot():
        result = {"steps": steps, "cost_usd": round(prior_cost + cost, 5), "reports": reports,
                  "actions_by_step": by_step, "log": log, "fallbacks": initial.get("fallbacks", 0) + fallbacks, "started_at": initial.get("started_at", t0),
                  "checklist": items, "nudges": initial.get("nudges", 0) + nudged}
        if hasattr(driver, "tick"):
            result["final_tick"] = driver.tick()
        if escalation is not None:
            result["escalation"] = escalation
        if sink is not None:
            sink.update(result)
        return result

    history, stateless, fallbacks = [], history == "own", 0     # what we sent and got: the input of an own history call, and the replay of a lost server chain
    shot_t = round(prior_seconds + time.time() - t0, 2)
    shot = filter_screenshot(driver.screenshot(), vision)
    shot_tick = driver.tick() if hasattr(driver, "tick") else None
    if on_step:
        on_step(steps, shot)
    inp = [{"role": "user", "content": [{"type": "input_text", "text": goal + _size_note(driver, shot) + _state_line(driver, observe_state)}, _img(shot)]}]
    while True:
        reasoning = {"effort": effort, **({"summary": summary} if summary else {})}
        body = {"instructions": system, "tools": tools_for(getattr(driver, "controls", ""), checklist, escalate, reload, look_plan, notes), "input": inp, "max_output_tokens": max_out, "reasoning": reasoning}
        snapshot()
        if prev and not stateless:
            body["previous_response_id"] = prev
        elif stateless:
            body.update({"store": False, "input": history + inp, "include": ["reasoning.encrypted_content"]})
        try:
            res = client.wonder(body, label=f"{label}:{steps}", reserve_usd=wonder_reserve(last_in, max_out))
        except ApiError as e:
            if e.status == 400 and "not found" in e.body and not stateless:
                stateless, fallbacks = True, fallbacks + 1      # the server lost the chain: send the whole history from now on
                body.pop("previous_response_id", None)
                body.update({"store": False, "input": history + inp, "include": ["reasoning.encrypted_content"]})
                res = client.wonder(body, label=f"{label}:{steps}:stateless", reserve_usd=wonder_reserve(last_in * 2, max_out))
            else:
                raise
        history += inp + [x for x in map(_replay_item, res["output"]) if x is not None]
        cost += res["_cost_usd"]
        prev = res["id"]
        last_in = (res.get("usage") or {}).get("input_tokens", last_in)
        calls = parse_calls(res["output"])
        log.append({"step": steps, "t": round(prior_seconds + time.time() - t0, 2), "shot_t": shot_t,
                    "cost": res["_cost_usd"], "latency_s": res["_latency_s"], "in": last_in,
                    "calls": [{"name": c["name"], "args": c["args"], "raw": c["raw"], "output": "not run"} for c in calls],
                    "text": _text(res["output"]) or res.get("_thought", "")})     # whole, word for word: the run video shows it as the model wrote it
        if shot_tick is not None:
            log[-1]["shot_tick"] = shot_tick
        usage = res.get("usage") or {}
        log[-1]["out"] = usage.get("output_tokens")
        log[-1]["reasoning_tokens"] = (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
        thinking = _thinking(res["output"])
        if thinking:
            log[-1]["thinking"] = thinking
        if not calls:
            left = max_steps - (steps - start_step)
            if nudged < nudges and left > 0 and cost < max_usd and time.time() - t0 < max_seconds:
                nudged += 1      # the model stopped early: one reminder of the steps it still has, built from nothing but the step count
                inp = [{"role": "user", "content": [{"type": "input_text", "text": NUDGE.format(
                    left=left, reload=" If the game is stuck, use the reload action and carry on." if reload else "")}]}]
                log[-1]["nudge"] = True
                continue
            final_text, stop = _text(res["output"]), "model"
            break
        outs, acted = [], False
        for c, logged_call in zip(calls, log[-1]["calls"]):
            if c["name"] == "act":
                acts = c["args"].get("actions") or []
                driver.execute(acts)
                action_note = getattr(driver, "action_note", "") or "done"
                if getattr(driver, "last_spans", None):
                    log[-1]["spans"] = list(driver.last_spans)       # the game frames of each action, for the run video
                by_step.append(acts)
                steps += 1
                acted = True
                outs.append({"type": "function_call_output", "call_id": c["call_id"], "output": action_note})
            elif c["name"] == "report_bug":
                reports.append({**c["args"], "step": steps, "status": "unverified"})
                outs.append({"type": "function_call_output", "call_id": c["call_id"], "output": "noted"})
            elif c["name"] == "set_checklist" and checklist:
                items = items[:prior_items] + [{"text": text, "done": False, "evidence": "", "step": steps} for text in c["args"].get("items", [])]
                outs.append({"type": "function_call_output", "call_id": c["call_id"], "output": "noted"})
            elif c["name"] == "tick" and checklist:
                index = c["args"].get("index")
                valid = type(index) is int and 0 <= index < len(items)
                if valid:
                    items[index].update(done=True, evidence=c["args"].get("evidence", ""), step=steps)
                outs.append({"type": "function_call_output", "call_id": c["call_id"], "output": "noted" if valid else "no such item"})
            elif c["name"] == "escalate" and escalate:
                escalation = {"reason": c["args"].get("reason", ""), "question": c["args"].get("question", ""), "step": steps}
                stop = "escalated"
                logged_call["output"] = "noted"
                break
            else:
                outs.append({"type": "function_call_output", "call_id": c["call_id"], "output": "unknown tool"})
            logged_call["output"] = outs[-1]["output"]
        log[-1]["checklist"] = copy.deepcopy(items)
        snapshot()
        if stop == "escalated":
            break
        if acted and _won(driver):
            stop = "won"
            break
        if steps - start_step >= max_steps:
            stop = "steps"
            break
        if cost >= max_usd:
            stop = "cost"
            break
        if time.time() - t0 >= max_seconds:
            stop = "time"
            break
        reason = should_stop() if should_stop else None
        if reason:
            stop = reason
            break
        shot_t = round(prior_seconds + time.time() - t0, 2)
        shot = filter_screenshot(driver.screenshot(), vision)
        shot_tick = driver.tick() if hasattr(driver, "tick") else None
        if on_step:
            on_step(steps, shot)
        inp = outs + [{"role": "user", "content": [{"type": "input_text", "text": "Screenshot after your actions." + _size_note(driver, shot) + _state_line(driver, observe_state)}, _img(shot)]}]
    result = {**snapshot(), "stop": stop, "seconds": round(prior_seconds + time.time() - t0, 1), "final_text": final_text}
    if sink is not None:
        sink.update(result)
    return result
