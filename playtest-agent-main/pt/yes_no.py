"""Ask the replay judge for a yes or no verdict, with room for reasoning."""
import re

from metaclient.client import output_text
from pt import replay


def ask(client, report, first, last, label):
    text = replay.PROMPT.format(title=report.get("title", ""),
                                expected=report.get("expected", ""),
                                actual=report.get("actual", ""))
    inp = [{"role": "user", "content": [
        {"type": "input_text", "text": text}, replay._img(first), replay._img(last)
    ]}]
    total_cost = 0
    response_text = ""
    tries = 0
    for max_tokens, reserve, call_label in ((1500, .03, label), (6000, .08, label + ":room")):
        tries += 1
        response = client.responses(inp, max_output_tokens=max_tokens, label=call_label,
                                    reserve_usd=reserve)
        response_text = output_text(response) or ""
        total_cost += response.get("_cost_usd", 0)
        if tries == 1 and (response.get("status") == "incomplete" or not response_text):
            continue
        break
    answered = bool(re.match(r"\s*(yes|no)\b", response_text, re.I))
    return {"answered": answered, "yes": replay.parse_verdict(response_text) if answered else None,
            "text": response_text[:400], "cost_usd": total_cost, "tries": tries}
