"""Compare one saved Cave Courier frame with its recorded true position."""
import argparse
import json
from pathlib import Path

from pt.sam_sensor import SamSensor

ROOT = Path(__file__).resolve().parents[1]


def saved_pair():
    """Use h12 only when the saved screenshot and final state have the same tick."""
    result_path = ROOT / "data" / "runs" / "h12" / "result.json"
    if not result_path.is_file():
        return None, None
    result = json.loads(result_path.read_text(encoding="utf-8"))
    if result.get("game_id") != "cave-courier" or not result.get("final_state"):
        return None, None
    tick = result.get("final_tick")
    for entry in reversed(result.get("log", [])):
        if tick is not None and entry.get("shot_tick") == tick:
            frame = result_path.parent / f's{entry["step"]:03d}.jpg'
            if frame.is_file():
                return frame, result_path
    # Recorded frames use the game tick in the filename.
    if type(tick) is int:
        frame = result_path.parent / "frames" / f"f{tick:08d}.jpg"
        if frame.is_file():
            return frame, result_path
    return None, None


def main(argv=None, client_factory=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--frame", type=Path, help="a saved Cave Courier JPEG or PNG")
    parser.add_argument("--state", type=Path, help="JSON state_js position saved with that frame")
    parser.add_argument("--phrase", default="the player character", help="SAM phrase for the player")
    args = parser.parse_args(argv)
    frame, state_path = args.frame, args.state
    if frame is None and state_path is None:
        frame, state_path = saved_pair()
    if not args.apply:
        if frame is not None and state_path is not None:
            print(f"Using frame: {frame}\nUsing state: {state_path}")
            print("No call made. Use --apply for one SAM call (about $0.003).")
        else:
            print("No call made. Give --frame FRAME --state STATE for a saved Cave Courier frame and its matching state_js position.")
        return 0
    if frame is None or state_path is None:
        parser.error("give --frame and --state for a saved Cave Courier frame and its matching state_js position")
    truth = json.loads(state_path.read_text(encoding="utf-8"))
    truth = truth.get("final_state", truth)
    image = frame.read_bytes()
    if not isinstance(truth, dict) or not all(k in truth for k in ("x", "y")):
        parser.error("the saved true state needs x and y")
    if client_factory is None:
        from trials.common import load_client
        client_factory = lambda: load_client("playtest-agent")
    sensor = SamSensor(client_factory(), args.phrase)
    position = sensor.sense(image)
    print(json.dumps({"frame": str(frame), "state": str(state_path), "phrase": args.phrase, "sam": position, "true_state": truth,
                      "calls": len(sensor.calls), "cost_usd": sum(c["cost_usd"] for c in sensor.calls)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
