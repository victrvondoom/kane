"""Compatibility wrapper: the first test game through the general web adapter."""
from pt.adapter import make


def Driver(bugs="", debug=False):
    return make("cave-courier", bugs=bugs, debug=debug)
