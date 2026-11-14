"""Every public file imports only our modules that are also public. Found 28 Oct on a fresh Ubuntu copy: the public tests did not
even load ("cannot import name 'build_times' from 'tools'"), because tests/test_build_times.py shipped and tools/build_times.py did not."""
import ast
from pathlib import Path

from tools import make_public

ROOT = Path(__file__).resolve().parents[1]
OURS = {"pt", "tools", "trials", "pw", "metaclient", "bench", "deploy", "game"}


def our_imports(text):
    """Module paths like 'tools/build_times.py' or 'tools/build_times/__init__.py' that a file imports from our packages."""
    out = set()
    for node in ast.walk(ast.parse(text)):
        names = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names = [node.module] + [f"{node.module}.{a.name}" for a in node.names]
        for n in names:
            if n.split(".")[0] in OURS:
                out.add(n)
    return out


def exists_in(name, shipped):
    path = name.replace(".", "/")
    return f"{path}.py" in shipped or f"{path}/__init__.py" in shipped


def is_module(name):
    path = ROOT / name.replace(".", "/")
    return path.with_suffix(".py").is_file() or (path / "__init__.py").is_file()


def test_our_imports_are_found():
    assert our_imports("from tools import build_times\nimport pt.guard as G\nimport json\n") == {"tools", "tools.build_times", "pt.guard"}


def test_every_public_python_file_imports_only_public_modules():
    shipped = set(make_public.selected(ROOT, make_public.read_manifest(ROOT / "tools" / "public_manifest.txt")))
    missing = []
    for f in sorted(x for x in shipped if x.endswith(".py")):
        for name in our_imports((ROOT / f).read_text(encoding="utf-8")):
            if is_module(name) and not exists_in(name, shipped):
                missing.append(f"{f} imports {name}")
    assert not missing, missing
