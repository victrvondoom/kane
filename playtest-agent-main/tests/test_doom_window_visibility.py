"""Real ViZDoom instances in tests must stay off the user's display."""
import ast
from pathlib import Path


TESTS = Path(__file__).resolve().parent


def test_real_doom_games_hide_the_window_before_init():
    violations = []
    for path in sorted(TESTS.glob("test_*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        for function in (node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))):
            calls = sorted(
                (node for node in ast.walk(function) if isinstance(node, ast.Call)),
                key=lambda node: (node.lineno, node.col_offset),
            )
            for index, call in enumerate(calls):
                if not (isinstance(call.func, ast.Attribute) and call.func.attr == "DoomGame"):
                    continue
                later = calls[index + 1:]
                hidden = any(
                    isinstance(item.func, ast.Attribute)
                    and item.func.attr == "set_window_visible"
                    and len(item.args) == 1
                    and isinstance(item.args[0], ast.Constant)
                    and item.args[0].value is False
                    for item in later
                )
                if not hidden:
                    violations.append(f"{path.name}:{call.lineno} constructs DoomGame without hiding its window before init")
    assert not violations, violations
