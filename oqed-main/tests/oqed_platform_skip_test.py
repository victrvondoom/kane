"""Reports why the oqed suite is skipped on this platform (see conftest.py).

Named *_test.py so it is collected even though the test_*.py modules are not.
"""

import sys

import pytest

def test_oqed_platform_requirement():
    if not sys.platform.startswith("linux"):
        pytest.skip(
            "oqed requires Linux x86-64; the native harness does not build on " + sys.platform
        )
