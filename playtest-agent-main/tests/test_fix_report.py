"""Fix report counts keep unproved changed lines separate."""
from pt.fix_report import render


def test_report_shows_proved_and_changed_line_counts(tmp_path):
    page = render({"fixed": 2, "total": 4, "line_changed_judge_fixed": 1}, tmp_path)
    assert "2 of 4 fixed and proved" in page
    assert "1 line changed, judge says fixed" in page
    assert "the hook check can not see a hook whose line the patch changed" in page
