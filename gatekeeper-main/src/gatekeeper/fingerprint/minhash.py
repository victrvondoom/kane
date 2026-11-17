"""Near-duplicate source fingerprinting: normalised tokens, shingles, MinHash signatures and LSH (Algorithm 6).

Exact hashes miss a copy whose identifiers were renamed or whose formatting changed. This module:

1. normalises a JavaScript-like token stream: comments and whitespace are dropped, string and number literals are
   replaced by placeholders, and user identifiers are replaced by ``I``. Words that carry capability meaning
   (``require``, ``child_process``, ``exec``, ``http``, ``fetch`` ...) are kept, so renaming a variable does not
   hide what the code does, while renaming a helper still produces the same fingerprint;
2. builds token k-shingles and a MinHash signature (seeded universal hashing over a Mersenne prime);
3. retrieves candidates with locality-sensitive hashing (banding) without comparing every pair;
4. verifies candidates by exact shingle Jaccard similarity.

A similarity relationship is evidence of shared origin, not of maliciousness. Callers must combine it with
publisher, dependency, endpoint and install-behaviour evidence before drawing any campaign conclusion, and
must record the reason for every relationship.
"""

from __future__ import annotations

import hashlib
import random
import re
from dataclasses import dataclass, field

_PRIME = (1 << 61) - 1
_MAX_HASH = (1 << 32) - 1

# Keywords and names that carry capability meaning. They are kept verbatim by normalisation.
KEEP = frozenset("""
break case catch class const continue debugger default delete do else export extends finally for function if import in
instanceof let new return super switch this throw try typeof var void while with yield async await of from as static get set
true false null undefined require module exports process env argv cwd exec execSync spawn spawnSync fork child_process
fs readFile readFileSync writeFile writeFileSync http https net dns tls socket connect write end request fetch XMLHttpRequest
WebSocket Buffer atob btoa eval Function console JSON Math Date Promise setTimeout setInterval os homedir hostname platform
userInfo networkInterfaces homedir cookie localStorage sessionStorage navigator window document location
""".split())

_TOKEN = re.compile(
    r"""//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`"""
    r"""|[A-Za-z_$][\w$]*|\d[\w.]*|===|!==|==|!=|<=|>=|=>|&&|\|\||\+\+|--|[^\s]""",
    re.S,
)


def normalized_tokens(source: str) -> list[str]:
    """Rename- and formatting-invariant token stream."""
    out: list[str] = []
    for m in _TOKEN.finditer(source):
        t = m.group(0)
        if t.startswith("//") or t.startswith("/*"):
            continue
        if t == ";":
            continue  # statement terminators are optional in JavaScript: a formatting choice, not code
        if t[0] in "\"'`":
            out.append("S")
        elif t[0].isdigit():
            out.append("N")
        elif t[0].isalpha() or t[0] in "_$":
            out.append(t if t in KEEP else "I")
        else:
            out.append(t)
    return out


def shingles(tokens: list[str], k: int = 5) -> set[int]:
    """Set of k-token shingles as stable 64-bit hashes (independent of PYTHONHASHSEED)."""
    if k < 1:
        raise ValueError("k must be at least 1")
    if len(tokens) < k:
        return {_stable_hash(" ".join(tokens))} if tokens else set()
    return {_stable_hash(" ".join(tokens[i:i + k])) for i in range(len(tokens) - k + 1)}


def _stable_hash(text: str) -> int:
    return int.from_bytes(hashlib.blake2b(text.encode("utf-8"), digest_size=8).digest(), "big")


@dataclass(frozen=True)
class Hasher:
    """A family of seeded universal hash functions: h(x) = (a*x + b) mod P, then truncated to 32 bits."""

    num_perm: int = 128
    seed: int = 1
    coeffs: tuple[tuple[int, int], ...] = field(default=(), compare=False)

    def __post_init__(self):
        if self.num_perm < 2:
            raise ValueError("num_perm must be at least 2")
        rng = random.Random(self.seed)
        coeffs = tuple((rng.randrange(1, _PRIME), rng.randrange(0, _PRIME)) for _ in range(self.num_perm))
        object.__setattr__(self, "coeffs", coeffs)

    def signature(self, items: set[int]) -> tuple[int, ...]:
        if not items:
            return tuple([_MAX_HASH] * self.num_perm)
        sig = []
        for a, b in self.coeffs:
            sig.append(min(((a * (x % _PRIME) + b) % _PRIME) & _MAX_HASH for x in items))
        return tuple(sig)


def jaccard_estimate(sig_a: tuple[int, ...], sig_b: tuple[int, ...]) -> float:
    """Fraction of MinHash positions that agree: an unbiased estimate of exact Jaccard similarity."""
    if len(sig_a) != len(sig_b):
        raise ValueError("signatures come from different hashers")
    return sum(1 for x, y in zip(sig_a, sig_b) if x == y) / len(sig_a)


def jaccard_exact(a: set[int], b: set[int]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


class LSHIndex:
    """Banded locality-sensitive hashing. Two items are candidates when they agree on every row of some band.

    With b bands of r rows (b * r = num_perm), the candidate probability for Jaccard s is 1 - (1 - s**r) ** b.
    """

    def __init__(self, num_perm: int = 128, bands: int = 32):
        if num_perm % bands:
            raise ValueError("bands must divide num_perm")
        self.bands, self.rows = bands, num_perm // bands
        self.buckets: list[dict[tuple, list[str]]] = [dict() for _ in range(bands)]
        self.signatures: dict[str, tuple[int, ...]] = {}
        self.lookups = 0
        self.bucket_pairs = 0

    def threshold(self) -> float:
        """Similarity at which a pair becomes a candidate with probability ~1/2."""
        return (1 / self.bands) ** (1 / self.rows)

    def add(self, key: str, sig: tuple[int, ...]) -> None:
        if key in self.signatures:
            raise ValueError(f"duplicate key {key!r}")
        self.signatures[key] = sig
        for band in range(self.bands):
            part = sig[band * self.rows:(band + 1) * self.rows]
            self.buckets[band].setdefault(part, []).append(key)

    def query(self, sig: tuple[int, ...]) -> set[str]:
        found: set[str] = set()
        for band in range(self.bands):
            part = sig[band * self.rows:(band + 1) * self.rows]
            bucket = self.buckets[band].get(part, [])
            self.lookups += len(bucket)
            found.update(bucket)
        return found

    def candidate_pairs(self) -> set[tuple[str, str]]:
        """Pairs that share a bucket in at least one band. `self.bucket_pairs` counts the within-bucket pairs
        enumerated before de-duplication: the real work of this lookup."""
        pairs: set[tuple[str, str]] = set()
        self.bucket_pairs = 0
        for bucket_table in self.buckets:
            for members in bucket_table.values():
                for i in range(len(members)):
                    for j in range(i + 1, len(members)):
                        self.bucket_pairs += 1
                        pairs.add(tuple(sorted((members[i], members[j]))))
        return pairs


@dataclass(frozen=True)
class Fingerprint:
    key: str
    sha256_raw: str
    sha256_normalized: str
    shingles: frozenset
    signature: tuple


def fingerprint(key: str, source: str, *, hasher: Hasher, k: int = 5) -> Fingerprint:
    tokens = normalized_tokens(source)
    sh = shingles(tokens, k)
    return Fingerprint(
        key=key,
        sha256_raw=hashlib.sha256(source.encode("utf-8")).hexdigest(),
        sha256_normalized=hashlib.sha256(" ".join(tokens).encode("utf-8")).hexdigest(),
        shingles=frozenset(sh),
        signature=hasher.signature(sh),
    )


@dataclass(frozen=True)
class Relationship:
    a: str
    b: str
    kind: str                # "identical" | "identical_after_normalisation" | "near_duplicate"
    estimated_jaccard: float
    exact_jaccard: float
    reason: str


def find_relationships(fps: list[Fingerprint], *, bands: int = 32, verify_threshold: float = 0.5) -> tuple[list[Relationship], dict]:
    """Relationships among a corpus. Exact hash equality is checked first; LSH supplies the near-duplicate candidates,
    each verified by exact shingle Jaccard before it is reported."""
    by_key = {f.key: f for f in fps}
    if len(by_key) != len(fps):
        raise ValueError("fingerprint keys must be unique")
    out: list[Relationship] = []
    exact_pairs: set[tuple[str, str]] = set()
    raw_groups: dict[str, list[str]] = {}
    norm_groups: dict[str, list[str]] = {}
    for f in fps:
        raw_groups.setdefault(f.sha256_raw, []).append(f.key)
        norm_groups.setdefault(f.sha256_normalized, []).append(f.key)
    for members, kind in ((raw_groups, "identical"), (norm_groups, "identical_after_normalisation")):
        for group in members.values():
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    pair = tuple(sorted((group[i], group[j])))
                    if pair in exact_pairs:
                        continue
                    exact_pairs.add(pair)
                    out.append(Relationship(pair[0], pair[1], kind, 1.0, 1.0,
                                            "Byte-identical sources." if kind == "identical" else "Identical token streams: same code, different names or formatting."))
    idx = LSHIndex(num_perm=len(fps[0].signature) if fps else bands, bands=bands)
    for f in fps:
        idx.add(f.key, f.signature)
    candidates = idx.candidate_pairs()
    verified = 0
    for a, b in sorted(candidates):
        if (a, b) in exact_pairs:
            continue
        fa, fb = by_key[a], by_key[b]
        ex = jaccard_exact(set(fa.shingles), set(fb.shingles))
        est = jaccard_estimate(fa.signature, fb.signature)
        verified += 1
        if ex >= verify_threshold:
            out.append(Relationship(a, b, "near_duplicate", round(est, 4), round(ex, 4),
                                    f"Exact token-shingle Jaccard {ex:.2f} (MinHash estimate {est:.2f}). Shared code shape, not a maliciousness finding."))
    out.sort(key=lambda r: (-r.exact_jaccard, r.a, r.b))
    stats = {"fingerprints": len(fps), "candidate_pairs": len(candidates), "bucket_pairs_enumerated": idx.bucket_pairs,
             "verified": verified, "relationships": len(out), "lsh_threshold": round(idx.threshold(), 4)}
    return out, stats
