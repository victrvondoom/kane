"""Algorithm 6 — MinHash / LSH near-duplicate fingerprints. Deterministic: every corpus is generated from a seed."""

import random

import pytest

from gatekeeper.fingerprint.minhash import (
    Hasher, LSHIndex, find_relationships, fingerprint, jaccard_estimate, jaccard_exact, normalized_tokens, shingles,
)

HASHER = Hasher(num_perm=128, seed=7)


def _body(rng: random.Random, n: int, names: list[str]) -> str:
    lines = []
    for i in range(n):
        a, b = rng.choice(names), rng.choice(names)
        op = rng.choice(["+", "-", "*"])
        lines.append(f"  const {a}{i} = {b} {op} {rng.randrange(1000)};")
        lines.append(f"  if ({a}{i} > {b}) {{ out.push('{rng.choice(['x', 'y', 'z'])}{i}'); }}")
    return "function run(out) {\n" + "\n".join(lines) + "\n  return out;\n}\n"


def _body_alt(rng: random.Random, n: int, names: list[str]) -> str:
    """A different grammar (classes, switch, template strings): structurally unlike `_body`."""
    parts = [f"class {rng.choice(names)} {{"]
    for i in range(n):
        parts.append(f"  m{i}(x) {{ switch (x.{rng.choice(names)}) {{ case {i}: return `t${{x}}-{i}`; default: break; }} }}")
        parts.append(f"  static s{i} = new Map([[{rng.randrange(99)}, {rng.choice(names)}]]);")
    parts.append("}\nwhile (false) { }\n")
    return "\n".join(parts)


def _rename(src: str, mapping: dict[str, str]) -> str:
    import re
    return re.sub(r"\b(" + "|".join(map(re.escape, mapping)) + r")\b", lambda m: mapping[m.group(0)], src)


def test_normalisation_is_invariant_to_renaming_and_formatting_but_keeps_capabilities():
    a = "const x = require('child_process');  // run a command\nx.exec(cmd);\n"
    b = "const   helper=require( 'child_process' )\n\n\n helper.exec( other );"
    assert normalized_tokens(a) == normalized_tokens(b)
    toks = normalized_tokens(a)
    assert "require" in toks and "exec" in toks and "child_process" not in toks, "module names are capability words, kept"
    assert "S" in toks, "string literals are placeholders"
    assert "run" not in " ".join(toks), "comments are dropped"


def test_normalisation_does_not_hide_a_different_capability():
    assert normalized_tokens("fetch(url)") != normalized_tokens("require(url)")


def test_shingles_are_deterministic_and_k_is_validated():
    toks = normalized_tokens("a = b + c;\nd = e;\n")
    assert shingles(toks, 3) == shingles(toks, 3)
    assert len(shingles(toks, 3)) == len({tuple(toks[i:i + 3]) for i in range(len(toks) - 2)})
    with pytest.raises(ValueError):
        shingles(toks, 0)


def test_hasher_is_seeded_and_validates_size():
    assert Hasher(num_perm=16, seed=3).coeffs == Hasher(num_perm=16, seed=3).coeffs
    assert Hasher(num_perm=16, seed=3).coeffs != Hasher(num_perm=16, seed=4).coeffs
    with pytest.raises(ValueError):
        Hasher(num_perm=1)


def test_minhash_estimate_tracks_exact_jaccard():
    rng = random.Random(11)
    base = set(range(0, 600))
    for overlap in (100, 300, 500):
        other = set(range(600 - overlap, 1200 - overlap))
        exact = jaccard_exact(base, other)
        est = jaccard_estimate(HASHER.signature(base), HASHER.signature(other))
        assert abs(est - exact) < 0.12, (overlap, est, exact)
    assert jaccard_estimate(HASHER.signature(base), HASHER.signature(base)) == 1.0
    assert rng is not None


def test_lsh_retrieves_a_near_duplicate_and_not_an_unrelated_file():
    rng = random.Random(2)
    names = [f"v{i}" for i in range(40)]
    original = _body(rng, 60, names)
    near = original.replace("  return out;", "  // patched\n  return out;")  # small edit, same shape
    unrelated = _body(random.Random(99), 60, [f"q{i}" for i in range(40)]).replace("out.push", "emit")
    fps = [fingerprint(k, s, hasher=HASHER) for k, s in [("orig", original), ("near", near), ("other", unrelated)]]
    idx = LSHIndex(num_perm=128, bands=32)
    for f in fps:
        idx.add(f.key, f.signature)
    assert "near" in idx.query(fps[0].signature)
    assert idx.candidate_pairs() >= {("near", "orig")}


def test_relationships_report_identical_renamed_and_near_duplicate_with_reasons():
    rng = random.Random(5)
    names = [f"n{i}" for i in range(50)]
    base = _body(rng, 80, names)
    renamed = _rename(base, {n: f"zz{n}" for n in names})  # identical shape, different names
    reformatted = base.replace("\n", "\n\n")               # byte-different, token-identical
    small_edit = base.replace("return out;", "return out.slice();")
    unrelated = _body_alt(random.Random(123), 80, [f"u{i}" for i in range(50)])
    corpus = {"base": base, "renamed": renamed, "reformatted": reformatted, "small_edit": small_edit, "unrelated": unrelated}
    fps = [fingerprint(k, v, hasher=HASHER) for k, v in corpus.items()]
    rels, stats = find_relationships(fps, verify_threshold=0.5)
    pairs = {(r.a, r.b): r for r in rels}
    assert pairs[("base", "reformatted")].kind == "identical_after_normalisation"
    assert pairs[("base", "renamed")].kind == "identical_after_normalisation"
    assert ("base", "small_edit") in pairs and pairs[("base", "small_edit")].kind == "near_duplicate"
    assert all("unrelated" not in (r.a, r.b) for r in rels), "unrelated code is not attributed"
    assert "Shared code shape, not a maliciousness finding." in pairs[("base", "small_edit")].reason
    assert stats["fingerprints"] == 5 and stats["relationships"] == len(rels)


def test_shared_boilerplate_alone_is_not_a_campaign_relationship():
    header = "'use strict';\nconst express = require('express');\nconst app = express();\napp.use(express.json());\n" * 6
    a = header + _body(random.Random(1), 60, [f"a{i}" for i in range(30)])
    b = header + _body_alt(random.Random(2), 60, [f"b{i}" for i in range(30)])
    fps = [fingerprint("a", a, hasher=HASHER), fingerprint("b", b, hasher=HASHER)]
    rels, _ = find_relationships(fps, verify_threshold=0.5)
    exact = jaccard_exact(set(fps[0].shingles), set(fps[1].shingles))
    assert 0.1 < exact < 0.5, "the corpus really shares boilerplate, but not a body"
    assert rels == []


def test_invalid_inputs_are_rejected():
    with pytest.raises(ValueError):
        LSHIndex(num_perm=128, bands=30)
    with pytest.raises(ValueError):
        find_relationships([fingerprint("k", "a", hasher=HASHER), fingerprint("k", "b", hasher=HASHER)])
    with pytest.raises(ValueError):
        jaccard_estimate((1, 2), (1, 2, 3))
