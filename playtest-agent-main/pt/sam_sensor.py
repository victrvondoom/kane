"""Screenshot positions from SAM, with a cache shared by replay copies."""
import hashlib
import json
import math
from pathlib import Path

from metaclient.client import SAM, sam_image_cost


class SamSensor:
    def __init__(self, client, phrase, cache_dir=None, size=None, tolerance=2.0):
        self.client, self.phrase = client, phrase
        self.cache_dir = Path(cache_dir) if cache_dir is not None else None
        self.size = tuple(size) if size is not None else None
        self.tolerance = tolerance
        self.cache = {}
        self.calls = []
        self.reads = []

    def sense(self, image):
        digest = hashlib.sha256(image).hexdigest()
        key_text = SAM + "\0" + self.phrase + "\0" + digest
        if self.size is not None:
            key_text += "\0" + json.dumps([list(self.size), self.tolerance], separators=(",", ":"))
        key = hashlib.sha256(key_text.encode("utf-8")).hexdigest()
        path = self.cache_dir / (key + ".json") if self.cache_dir is not None else None
        if key not in self.cache and path is not None and path.exists():
            self.cache[key] = json.loads(path.read_text(encoding="utf-8"))
        if key in self.cache:
            state = dict(self.cache[key])
            self.reads.append({"image_sha256": digest, "state": state, "cached": True})
            return state
        if self.client is None:
            raise ValueError("sam_player needs a SAM client")
        mime = "image/png" if image.startswith(b"\x89PNG") else "image/jpeg"
        response = self.client.sam_image(image, self.phrase, mime=mime, label="sam_position")
        self.calls.append({"image_sha256": digest, "cost_usd": response.get("_cost_usd", sam_image_cost())})
        records = (response.get("_records") or {}).get(0, [])
        valid = [r for r in records if len(r.box) == 4 and all(math.isfinite(v) for v in r.box)
                 and r.box[2] > r.box[0] and r.box[3] > r.box[1]]
        state = {"x": None, "y": None, "w": 0, "h": 0, "found": False, "score": 0}
        state["boxes"] = [[*r.box, r.conf if r.conf is not None else 0] for r in valid]
        candidates = valid
        rejected = 0
        if self.size is not None:
            width, height = self.size
            candidates = [r for r in valid
                          if width / self.tolerance <= r.box[2] - r.box[0] <= width * self.tolerance
                          and height / self.tolerance <= r.box[3] - r.box[1] <= height * self.tolerance]
            rejected = len(valid) - len(candidates)
            if not candidates:
                state["rejected"] = rejected
        if candidates:
            if self.size is None:
                best = max(candidates, key=lambda r: r.conf if r.conf is not None else 0)
            else:
                width, height = self.size
                best = min(candidates, key=lambda r: (
                    abs(math.log((r.box[2] - r.box[0]) / width))
                    + abs(math.log((r.box[3] - r.box[1]) / height)),
                    -(r.conf if r.conf is not None else 0)))
            x1, y1, x2, y2 = best.box
            state = {"x": (x1 + x2) / 2, "y": (y1 + y2) / 2, "w": x2 - x1, "h": y2 - y1,
                     "found": True, "score": best.conf if best.conf is not None else 0,
                     "boxes": [[*r.box, r.conf if r.conf is not None else 0] for r in valid]}
        self.cache[key] = state
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(state), encoding="utf-8")
        self.reads.append({"image_sha256": digest, "state": dict(state), "cached": False})
        return dict(state)


def configure(driver, client=None, cache_dir=None):
    cfg = getattr(driver, "cfg", {})
    if cfg.get("sam_player") and not cfg.get("state_js"):
        driver._sam_sensor = SamSensor(client, cfg["sam_player"], cache_dir,
                                       cfg.get("sam_player_size"), cfg.get("sam_size_tolerance", 2.0))
        driver._sam_step = 0
        driver._sam_sample_step = None
        driver._sam_last = None
    return driver


def position(driver):
    sensor = getattr(driver, "_sam_sensor", None)
    if sensor is None:
        return None
    step = driver._sam_step
    if driver._sam_last is None or (step % driver.cfg.get("sam_every", 1) == 0 and step != driver._sam_sample_step):
        observe(driver, driver.screenshot())
    return {**driver._sam_last, "stale": step != driver._sam_sample_step}


def observe(driver, image):
    sensor = getattr(driver, "_sam_sensor", None)
    if sensor is None:
        return image
    step = driver._sam_step
    if driver._sam_last is None or (step % driver.cfg.get("sam_every", 1) == 0 and step != driver._sam_sample_step):
        driver._sam_last = sensor.sense(image)
        driver._sam_sample_step = step
    return image


def advance(driver):
    if getattr(driver, "_sam_sensor", None) is not None:
        driver._sam_step += 1


def add_usage(result, driver):
    sensor = getattr(driver, "_sam_sensor", None)
    if sensor is None:
        return
    cost = sum(call["cost_usd"] for call in sensor.calls)
    result["sam"] = {"calls": len(sensor.calls), "cost_usd": cost, "requests": list(sensor.calls),
                     "player": sensor.phrase, "every": driver.cfg.get("sam_every", 1),
                     "reads": list(sensor.reads), "found": sum(r["state"].get("found") is True for r in sensor.reads)}
    rejected = sum(r["state"].get("rejected", 0) > 0 for r in sensor.reads)
    if sensor.size is not None:
        result["sam"]["size_filter"] = {"size": list(sensor.size), "tolerance": sensor.tolerance,
                                         "tuned_on": "frame s000 of i8b-sam-proof"}
    if rejected:
        result["sam"]["rejected"] = rejected
    result["position_source"] = "sam"
    result["cost_usd"] = round(result.get("cost_usd", 0) + cost, 8)
