"""
Tests for the monitoring-window rules that gate minute aggregates.

The greenhouse "Monitoring Time Window" is set in the Admin/Manager UI and
stored in greenhouses.window_start / window_end. It was collected and
displayed but never enforced on the aggregate path: every reading forwarded
by the Pi became a sensor_minute_aggregates row regardless of the hour, so
the tables and the trend charts showed 24 hours of data instead of the
window the operator configured.

These tests pin the rule itself, in the one place it can be executed without
a live database. The SQL migration implements the same rule; the cases below
are the specification it has to match, including the overnight wrap that a
naive `start <= now <= end` comparison silently gets wrong.
"""
import pytest
from datetime import time

from app import is_within_window, parse_time


# ---------------------------------------------------------------------------
# parse_time
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("00:00", time(0, 0)),
        ("00:01", time(0, 1)),
        ("09:05", time(9, 5)),
        ("12:00", time(12, 0)),
        ("18:30", time(18, 30)),
        ("23:00", time(23, 0)),
        ("23:59", time(23, 59)),
    ],
)
def test_parse_time_reads_a_clock_value(value, expected):
    assert parse_time(value) == expected


@pytest.mark.parametrize("value", ["", None, "24:00", "12:60", "abc", "1pm", "12"])
def test_parse_time_rejects_anything_that_is_not_a_clock_time(value):
    # An unparseable window must not be read as "always inside the window".
    # The failure this prevents: a typo in the modal silently disabling
    # monitoring, or silently recording everything.
    assert parse_time(value) is None


# ---------------------------------------------------------------------------
# is_within_window — the same-day case
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "current",
    ["18:30", "19:00", "21:45", "23:00"],
)
def test_a_time_inside_a_daytime_window_is_included(current):
    # The window edges are inclusive: an operator who sets 18:30-23:00 means
    # the 18:30 reading counts.
    assert is_within_window(current, "18:30", "23:00") is True


@pytest.mark.parametrize(
    "current",
    ["00:00", "06:00", "12:00", "18:29", "23:01"],
)
def test_a_time_outside_a_daytime_window_is_excluded(current):
    assert is_within_window(current, "18:30", "23:00") is False


# ---------------------------------------------------------------------------
# is_within_window — the overnight wrap
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "current",
    ["23:00", "23:59", "00:00", "01:30", "05:00"],
)
def test_a_window_that_wraps_past_midnight_includes_both_ends(current):
    # A plain `start <= current <= end` comparison would drop everything
    # after midnight, which is the majority of a 23:00-05:00 window and the
    # exact hours a night-time light-pollution study cares about.
    assert is_within_window(current, "23:00", "05:00") is True


@pytest.mark.parametrize(
    "current",
    ["12:00", "18:00", "21:59", "05:01", "12:30"],
)
def test_a_window_that_wraps_past_midnight_excludes_the_afternoon(current):
    assert is_within_window(current, "23:00", "05:00") is False


def test_a_window_covering_the_whole_day_includes_everything():
    assert is_within_window("00:00", "00:00", "23:59") is True
    assert is_within_window("23:59", "00:00", "23:59") is True
    assert is_within_window("12:34", "00:00", "23:59") is True


# ---------------------------------------------------------------------------
# is_within_window — degenerate input
# ---------------------------------------------------------------------------


def test_a_degenerate_window_starting_and_ending_at_the_same_minute_includes_it():
    # start == end is a one-minute window, not an empty one. Treating it as
    # empty would silently drop every reading for a greenhouse configured
    # that way, with no error anywhere.
    assert is_within_window("12:00", "12:00", "12:00") is True
    assert is_within_window("12:01", "12:00", "12:00") is False


@pytest.mark.parametrize(
    "start,end",
    [("", "23:00"), ("18:30", ""), ("", ""), ("nonsense", "23:00"), ("18:30", "99:99")],
)
def test_an_unparseable_window_excludes_everything(start, end):
    # Fails closed: a broken window must not record everything, which would
    # quietly put unmonitored hours into the tables. It also must not raise,
    # because a misconfigured greenhouse must not stop readings being stored
    # at the Pi.
    for current in ["00:00", "12:00", "23:59"]:
        assert is_within_window(current, start, end) is False


# ---------------------------------------------------------------------------
# The default window the project ships
# ---------------------------------------------------------------------------


def test_the_shipped_default_window_admits_the_early_evening():
    # ManagerView initialises the modal to 18:30-23:00, so this is the window
    # a greenhouse has before anyone edits it.
    assert is_within_window("19:00", "18:30", "23:00") is True
    assert is_within_window("02:00", "18:30", "23:00") is False
