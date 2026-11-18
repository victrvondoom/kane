"""Algorithm 6 benchmark: near-duplicate detection quality and lookup cost.

Dataset (say exactly what it is):
  - BASE files are real JavaScript sources from a repository (default: the SHIPPROOF server/ directory). Different
    base files are unrelated programs: they are the negatives.
  - VARIANTS are synthetic, derived from each base file with a seeded generator:
      rename    identifiers renamed and formatting changed (identical after normalisation by construction)
      edit      rename + formatting + about 3% of lines inserted
      heavy     rename + formatting + about 15% of lines inserted
      partial   rename + formatting of a contiguous half of the file (partial reuse, near the decision boundary)
  - A family = one base file and its variants. Positive pairs are pairs inside a family.
  - HARD NEGATIVES: every other base file starts with a 40-line shared boilerplate block, so unrelated files
    share real code.

Reported:
  - LSH candidate recall per variant type (does banding retrieve the pair at all?);
  - verified precision / recall at several exact-Jaccard thresholds, versus brute force over all pairs;
  - cost: fingerprinting time, LSH bucket pairs enumerated, pairs verified, and brute-force time for comparison.

Usage (from gatekeeper-main/, with an environment where gatekeeper is installed):
  PYTHONPATH=src python scripts/bench_minhash.py --source-dir ../server --out ../benchmarks/algorithm-intelligence/minhash.json
"""

from __future__ import annotations

import argparse
import json
import random
import re
import time
from pathlib import Path

from gatekeeper.fingerprint.minhash import KEEP, Hasher, LSHIndex, find_relationships, fingerprint, jaccard_exact

# Code, not comments: comments are dropped by normalisation, so a comment header would not be a real shared region.
BOILERPLATE = "\n".join(f'const sharedHeader{i} = "generated project boilerplate line {i}";' for i in range(40)) + "\n"
IDENT = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{3,}\b")
THRESHOLDS = (0.3, 0.4, 0.5, 0.6, 0.7)
VARIANTS = ("rename", "edit", "heavy", "partial")


def rename(src: str, rng: random.Random) -> str:
    names = sorted({m for m in IDENT.findall(src) if m not in KEEP})
    mapping = {n: f"v{rng.randrange(16 ** 6):06x}" for n in names}
    return IDENT.sub(lambda m: mapping.get(m.group(0), m.group(0)), src)


def reformat(src: str, rng: random.Random) -> str:
    lines = []
    for line in src.splitlines():
        if rng.random() < 0.3:
            line = re.sub(r"\s+", " ", line).strip()
        if rng.random() < 0.1:
            lines.append("")
        lines.append(line)
    return "\n".join(lines) + "\n"


def edit(src: str, rng: random.Random, fraction: float) -> str:
    lines = src.splitlines()
    for _ in range(max(1, int(len(lines) * fraction))):
        lines.insert(rng.randrange(len(lines) + 1), f"const patch_{rng.randrange(10 ** 6)} = {rng.randrange(10 ** 4)};")
    return "\n".join(lines) + "\n"


def build_corpus(base: dict[str, str], seed: int) -> dict[str, tuple[str, str, str]]:
    """entry key -> (family, variant kind, source)."""
    rng = random.Random(seed)
    corpus = {}
    for i, k in enumerate(sorted(base)):
        src = BOILERPLATE + base[k] if i % 2 == 0 else base[k]
        corpus[f"{k}#base"] = (k, "base", src)
        corpus[f"{k}#rename"] = (k, "rename", reformat(rename(src, rng), rng))
        corpus[f"{k}#edit"] = (k, "edit", edit(reformat(rename(src, rng), rng), rng, 0.03))
        corpus[f"{k}#heavy"] = (k, "heavy", edit(reformat(rename(src, rng), rng), rng, 0.15))
        lines = src.splitlines()
        start = rng.randrange(0, max(1, len(lines) // 2))
        corpus[f"{k}#partial"] = (k, "partial", reformat(rename("\n".join(lines[start:start + len(lines) // 2]), rng), rng))
    return corpus


def prf(predicted: set, positives: set) -> dict:
    tp = len(predicted & positives)
    return {"predicted": len(predicted), "precision": round(tp / len(predicted), 4) if predicted else None,
            "recall": round(tp / len(positives), 4) if positives else None}


def run(source_dir: Path, out: Path, seed: int, max_files: int) -> dict:
    files = sorted(p for p in source_dir.glob("*.js") if p.is_file())[:max_files]
    base = {p.name: p.read_text(encoding="utf-8") for p in files}
    corpus = build_corpus(base, seed)
    hasher = Hasher(num_perm=128, seed=seed)

    t0 = time.perf_counter()
    fps = {k: fingerprint(k, src, hasher=hasher) for k, (_, _, src) in corpus.items()}
    fp_ms = (time.perf_counter() - t0) * 1000
    family = {k: v[0] for k, v in corpus.items()}
    keys = sorted(corpus)
    positives = {tuple(sorted((a, b))) for i, a in enumerate(keys) for b in keys[i + 1:] if family[a] == family[b]}
    total_pairs = len(keys) * (len(keys) - 1) // 2

    # LSH candidates
    idx = LSHIndex(num_perm=128, bands=32)
    for k in keys:
        idx.add(k, fps[k].signature)
    t1 = time.perf_counter()
    cand = idx.candidate_pairs()
    lsh_ms = (time.perf_counter() - t1) * 1000

    # Exact Jaccard for every pair (brute-force reference, also used to score thresholds)
    t2 = time.perf_counter()
    sets = {k: fps[k].shingles for k in keys}
    exact = {}
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            exact[(a, b)] = jaccard_exact(set(sets[a]), set(sets[b]))
    brute_ms = (time.perf_counter() - t2) * 1000

    # Candidate recall per variant (is the pair retrieved at all?), and per-variant exact Jaccard distribution
    per_variant = {}
    for variant in VARIANTS:
        pairs = [tuple(sorted((f"{f}#base", f"{f}#{variant}"))) for f in base]
        in_cand = sum(1 for p in pairs if p in cand)
        jac = [exact[p] for p in pairs]
        per_variant[variant] = {"pairs": len(pairs), "lsh_candidate_recall": round(in_cand / len(pairs), 4),
                                "exact_jaccard_min": round(min(jac), 4), "exact_jaccard_median": round(sorted(jac)[len(jac) // 2], 4)}

    # Thresholded quality: LSH-restricted (the production path) versus brute force over all pairs
    sweep = []
    for t in THRESHOLDS:
        brute = {p for p, j in exact.items() if j >= t}
        lsh_pred = {p for p in cand if exact[p] >= t}
        sweep.append({"threshold": t, "brute_force": prf(brute, positives), "lsh": prf(lsh_pred, positives)})

    # Production relationship output (exact-normalised equality first, then LSH + verification at 0.5)
    t3 = time.perf_counter()
    rels, stats = find_relationships(list(fps.values()), bands=32, verify_threshold=0.5)
    rel_ms = (time.perf_counter() - t3) * 1000
    predicted = {tuple(sorted((r.a, r.b))) for r in rels}
    fp_pairs = [p for p in predicted if family[p[0]] != family[p[1]]]
    hard_neg_pairs = [p for p in fp_pairs]

    result = {
        "schema": "shipproof.bench.minhash/v1", "seed": seed,
        "dataset": "repository-derived base sources (server/*.js) with seeded synthetic variants; see module docstring",
        "base_files": len(base), "entries": len(keys), "positive_pairs": len(positives), "total_pairs": total_pairs,
        "lsh_config": {"num_perm": 128, "bands": 32, "rows": 4, "approx_candidate_threshold": round(idx.threshold(), 4)},
        "per_variant": per_variant,
        "threshold_sweep": sweep,
        "production": {"verify_threshold": 0.5, "relationships": len(rels), "false_positive_pairs": len(fp_pairs),
                       "precision": round(len(predicted & positives) / len(predicted), 4) if predicted else None,
                       "recall": round(len(predicted & positives) / len(positives), 4),
                       "stats": stats},
        "cost": {"fingerprint_ms": round(fp_ms, 1), "lsh_candidate_ms": round(lsh_ms, 2), "bucket_pairs_enumerated": idx.bucket_pairs,
                 "candidate_pairs": len(cand), "brute_force_all_pairs_ms": round(brute_ms, 1), "brute_force_pairs_compared": total_pairs,
                 "relationship_ms": round(rel_ms, 1)},
        "limitations": ["Variants are synthetic: real campaigns reuse code with unrelated edits and different structure.",
                        "The corpus is one repository's sources; the negatives are unrelated programs from that repository, not malicious packages.",
                        "Similarity is not a maliciousness label; a campaign conclusion needs additional evidence."],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seed", type=int, default=20260617)
    ap.add_argument("--max-files", type=int, default=60)
    a = ap.parse_args()
    r = run(a.source_dir, a.out, a.seed, a.max_files)
    print(json.dumps({k: r[k] for k in ("base_files", "entries", "positive_pairs", "per_variant", "threshold_sweep", "production", "cost")}, indent=1))


if __name__ == "__main__":
    main()
