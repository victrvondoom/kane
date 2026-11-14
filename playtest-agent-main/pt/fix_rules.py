"""Compare replay hooks before and after a repair."""


def fired_hooks(hits):
    if not isinstance(hits, dict):
        return set()
    hits = {str(k): v for k, v in hits.items()}
    return {n for n in range(1, 6) if hits.get(str(n)) is True}


def hook_result(before, after, judge_verdict):
    a, b = fired_hooks(before), fired_hooks(after)
    hits = {str(k): v for k, v in after.items()} if isinstance(after, dict) else {}
    gone = sorted(n for n in a if hits.get(str(n)) is False)
    not_measured = sorted(n for n in a if type(hits.get(str(n))) is not bool)
    rule = "none" if before is None and after is None else "before_after"
    if rule == "none":
        verdict = judge_verdict
    elif b - a:
        verdict = "new breakage"
    else:
        verdict = "fixed" if judge_verdict == "fixed" and gone and not not_measured else "still there"
    return {"hooks_before": sorted(a), "hooks_after": sorted(b),
            "hooks_gone": gone, "hooks_not_measured": not_measured,
            "judge_verdict": judge_verdict, "hook_rule": rule, "verdict": verdict}
