"""Test configuration for oqed.

oqed is a Linux x86-64 tool: its Rust harness uses Linux-only APIs (sched_setaffinity,
fork, mmap, rlimits) and the Python tests load the built native extension. On other
platforms the test modules cannot import, so they are skipped at collection with an
explicit reason instead of erroring. Run the suite on Linux (or WSL2) to exercise it.
"""

import sys

_SUPPORTED = sys.platform.startswith("linux")

collect_ignore_glob = [] if _SUPPORTED else ["test_*.py"]


def pytest_report_header(config):
    if _SUPPORTED:
        return None
    return (
        "oqed: tests skipped on this platform (requires Linux x86-64; "
        "the native harness does not build on " + sys.platform + ")"
    )
