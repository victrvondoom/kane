"""Python version check shared by command line entry points."""
import sys


def require_supported(version_info=None):
    version = sys.version_info if version_info is None else version_info
    if version < (3, 12):
        message = (
            "Python 3.12 or newer is needed; this is {}.{}.{}. "
            "On macOS: brew install python@3.12, then python3.12 -m venv .venv"
        ).format(version[0], version[1], version[2])
        raise SystemExit(message)
