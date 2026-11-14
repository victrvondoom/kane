"""Replay judge with temporal evidence and complete endpoint state values."""
import base64
import io
import json
import re

from PIL import Image, ImageDraw, ImageChops, ImageStat

from metaclient.client import output_text

# Mean grey difference on a 64x36 copy. Saved pictures, 1 Nov 2026: the same fight screen at two moments 2.49, a relic page and the next 1.38, event and fight 27.54, map and event 68.16. It sees a changed screen, not a changed small number such as health: the judge reads those.
PICTURE_LIMIT = 8.0

PROMPT = (
    "A tester reported a problem in a game. Judge whether this replay supports the reported symptom.\n"
    "Title: {title}\nExpected: {expected}\nSaw: {actual}\n\n"
    "The filmstrip replays the same actions on a fresh copy. Read left to right, top to bottom. "
    "It includes the first and last frames of the saved window, with up to twelve sampled frames. "
    "Some actions may fall between samples. The final frame is the report time.\n"
    "{state}"
    "Compare the expected change, the observed change, and the gap between them. "
    "Read visible messages and status values across the sequence, including intermediate frames. "
    "Endpoint values summarize the whole replay window, not just its final action. "
    "Equal endpoints can hide an intermediate change that was later reversed. "
    "An unchanged value can prove a missing effect when the sequence shows its trigger. "
    "A message announcing success is evidence of the trigger, not proof that its effect occurred. "
    "Check the actual result in the frames and state values. "
    "For a claim of a persistent failure, compare the final samples: a changing intermediate pose alone does not prove a lasting failure. "
    "The same action sequence was replayed. Accept reported inputs as replay context; "
    "a screenshot need not display the physical input itself. Independently verify the claimed outcome "
    "from the frames and state values, including the absence of an expected effect after that input. "
    "Distinguish a missing lasting effect from an unobserved transient event. "
    "A brief response may occur between sampled frames; absence from samples does not prove it never occurred. "
    "Answer NO if a claim depends only on such an unobserved transient event. "
    "Confirm a matching symptom without requiring every incidental detail or proposed cause to match. "
    "Answer NO when the replay shows correct behaviour or contradicts the claimed symptom, even if another problem is visible. "
    "Do not infer failure merely from an absent success message or an unseen event.\n"
    "Reply with JSON only: "
    "{{\"expected_change\": \"the required effect\", \"observed_change\": \"what the replay shows\", "
    "\"gap\": \"whether the difference matches the reported symptom\", "
    "\"verdict\": \"YES or NO\", \"evidence\": \"quote specific frame observations or state values that prove the verdict\"}}. "
    "If you cannot quote evidence, answer NO."
)


def _fmt(v):
    return str(int(v)) if isinstance(v, float) and v == int(v) else str(v)


def state_diff(before, after):
    """Describe every endpoint value, including values that stayed the same."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return []
    out = []
    for k in dict.fromkeys([*before, *after]):
        a = _fmt(before[k]) if k in before else "<missing>"
        b = _fmt(after[k]) if k in after else "<missing>"
        same = " (unchanged)" if k in before and k in after and before[k] == after[k] else ""
        out.append(f"{k}: {a} -> {b}{same}")
    return out


def pick_frames(frames, n):
    if len(frames) <= n:
        return list(frames)
    idx = sorted({round(i * (len(frames) - 1) / (n - 1)) for i in range(n)})
    return [frames[i] for i in idx]


def filmstrip(frames, cols=4, tile_w=320):
    ims = [Image.open(io.BytesIO(f)).convert("RGB") for f in frames]
    h = max(int(im.height * tile_w / im.width) for im in ims)
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tile_w, rows * h), (20, 20, 20))
    for i, im in enumerate(ims):
        t = im.resize((tile_w, int(im.height * tile_w / im.width)))
        x, y = (i % cols) * tile_w, (i // cols) * h
        sheet.paste(t, (x, y))
        ImageDraw.Draw(sheet).text((x + 4, y + 4), str(i + 1), fill=(255, 255, 0))
    b = io.BytesIO(); sheet.save(b, "JPEG", quality=80)
    return b.getvalue()


def states_equal(a, b, tol=2, pos_keys=("x", "y", "vx", "vy")):
    """Position keys may differ by tol; every other value must match exactly (a coin count off by one is a different state)."""
    if a is None and b is None:
        return True
    if not isinstance(a, dict) or not isinstance(b, dict) or a.keys() != b.keys():
        return False
    for k in a:
        x, y = a[k], b[k]
        if k in pos_keys and isinstance(x, (int, float)) and isinstance(y, (int, float)):
            if abs(x - y) > tol:
                return False
        elif x != y:
            return False
    return True


def compare_replays(a, b, tol=2):
    """Compare final states when available, otherwise final pictures, or decline."""
    sa, sb = (t.get("states", [])[-1] if t.get("states") else None for t in (a, b))
    if isinstance(sa, dict) or isinstance(sb, dict):
        return {"compared": True, "method": "state", "same": states_equal(sa, sb, tol)}
    if not a.get("frames") or not b.get("frames"):
        return {"compared": False, "method": "none", "same": None}
    pictures = []
    for trace in (a, b):
        with Image.open(io.BytesIO(trace["frames"][-1])) as picture:
            pictures.append(picture.convert("L").resize((64, 36), Image.Resampling.BILINEAR))
    difference = ImageStat.Stat(ImageChops.difference(*pictures)).mean[0]
    return {"compared": True, "method": "pictures", "same": difference <= PICTURE_LIMIT,
            "difference": round(difference, 2)}


def build_prompt(report, diff_lines):
    state = ("State values over the whole replay window, first frame -> last frame:\n" + "\n".join(diff_lines) + "\n\n") if diff_lines else "State unavailable. Use the frames; missing state is not evidence of no change.\n\n"
    return PROMPT.format(title=report.get("title", ""), expected=report.get("expected", ""), actual=report.get("actual", ""), state=state)


def parse_verdict(text):
    """(confirmed, evidence). A YES with no evidence is a NO."""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return False, ""
    try:
        d = json.loads(m.group(0))
    except ValueError:
        return False, ""
    ev = str(d.get("evidence", "")).strip()
    return (str(d.get("verdict", "")).strip().upper() == "YES" and len(ev) >= 8), ev


def judge(client, report, frames, diff_lines, label="judge", max_tokens=6000, judge_input="strip", video_bytes=None, second_frames=None):
    """Ask Spark. If the answer was cut off (the reasoning used all the room), ask once more with more room; say so if it still is."""
    if judge_input not in ("strip", "video"):
        raise ValueError("Unknown judge input: " + str(judge_input))
    if judge_input == "video" and second_frames is not None:
        raise ValueError("Second replay frames are not supported with video judge input")
    selected = pick_frames(frames, 12)
    strip = filmstrip(selected, tile_w=480)
    text = build_prompt(report, diff_lines)
    video = None
    media = {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(strip).decode()}
    if judge_input == "video":
        from pt.judge_video import encode, prompt
        video = video_bytes if video_bytes is not None else encode(selected)
        if video[4:8] != b"ftyp":
            raise ValueError("Judge video must be an MP4 with an ftyp box")
        text = prompt(text)
        media = {"type": "input_video", "video_url": "data:video/mp4;base64," + base64.b64encode(video).decode()}
    inp = [{"role": "user", "content": [{"type": "input_text", "text": text}, media]}]
    strip_b = None
    if second_frames is not None:
        strip_b = filmstrip(pick_frames(second_frames, 12), tile_w=480)
        inp[0]["content"][0]["text"] += (
            "\nThe second filmstrip is a second replay of the same actions on another fresh copy. "
            "Answer YES only if both replays show the reported symptom. Quote what each replay shows. "
            "If they disagree, answer NO.")
        inp[0]["content"].append({"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(strip_b).decode()})
    cost, incomplete, text = 0.0, True, ""
    for room in (max_tokens, int(max_tokens * 2.5)):
        reserve = (0.15 if room == max_tokens else 0.30) if video is not None else (0.05 if room == max_tokens else 0.12)
        d = client.responses(inp, max_output_tokens=room, label=label, reserve_usd=reserve, extra={"reasoning": {"effort": getattr(client, "reasoning", "low")}, "temperature": 0})
        cost += d["_cost_usd"]
        text = output_text(d)
        incomplete = d.get("status") == "incomplete"
        if not incomplete:
            break
    ok, ev = (False, "") if incomplete else parse_verdict(text)
    return {"confirmed": ok, "evidence": ev, "raw": text[:400], "cost_usd": cost, "incomplete": incomplete, "strip": strip,
            **({"strip_b": strip_b} if strip_b is not None else {}),
            **({"video": video} if video is not None else {})}
