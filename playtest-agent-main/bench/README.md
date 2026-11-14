# Public benchmark

Run from the repository root. These commands use the normal ledger and model
client, cost money, and start a browser. Respect the PC guard.

Cave Courier:

```powershell
python -m bench.run cave-courier --name cc1
```

Holdout (Lantern Rooms):

```powershell
python -m bench.run holdout --name ho1
```

Each command prints and runs the normal CLI commands for a hunt with bugs 1 to 5,
confirmation, a clean hunt, and clean confirmation. It then prints the score and
writes `data/runs/NAME/score.json`. Existing run folders are refused. Normal hunt
flags such as `--max-steps`, `--model` and `--offline` pass through. The runner
sets the game and bug flags. It adds nothing to the hunt prompt.

The sealed file is read only by the scorer. The runner never opens it, and its
contents never enter the hunt or judge prompt. The Cave Courier key, `bench/cave-courier/bugs.json`, contains
only its five public planted ids. The holdout key belongs to the game author.

To score saved runs again:

```powershell
python -m bench.score data/runs/ho1 --clean data/runs/ho1-clean
```

With no arguments, `python -m bench.score` uses `data/runs/ho1`. The scorer uses
the sibling `NAME-clean` folder when present. An absent clean run is shown as
null, never zero. `--sealed PATH` supplies another key, including a fake key for
tests. Keys contain a `bugs` list of objects with `id`, a list of ids, or a map
of bug ids. There must be five distinct ids.

The score fields provide the table: `found_confirmed` of `planted`,
`false_reports`, and `clean_false_reports`. No target or minimum result is
imposed. Repeated reports of the same bug count that bug once.

Flags are not findings. A found bug is a confirmed report that describes that
planted bug. When the game cannot timestamp hits, a person grades the reports
in `bench/<game>/grades/<run>.json`. The first holdout row is hand graded in
`bench/holdout/grades/ho1.json`: 3 found, 1 false report and 1 clean false report.
Bug 3 was reported but not confirmed; bug 2 was missed.

Hand grades name the run and clean run, with one row per report in `reports`
and `clean_reports`. Each row has its zero based `index`, exact `title`,
`confirmed` status, and a planted `bug_id` or null for a false report. Include
unconfirmed reports too; they do not count as found. The scorer checks the
indices, titles, confirmation status, bug ids and all totals against the saved
runs. Missing, extra or stale rows are errors. Totals use `planted`,
`found_confirmed`, `found_ids`, `reported_not_confirmed_ids`, `missed_ids`,
`false_reports` and `clean_false_reports`. Only bugs absent from both confirmed
and unconfirmed reports are missed. Valid grades supply the score with
`source` set to `hand grades`, including when a replay trace is also present.

The match window is `MATCH_WINDOW_STEPS`, K = 5, adjustable with
`--window-steps K`. A timestamped hit matches only at or before the report step,
within K steps. If several bugs qualify, the most recent hit wins; ties use key
order. Each report credits at most one bug when timing is available. All
candidates are included in the output for inspection.

Optional `RUN/replay_trace.json` stores entries like
`[{"step": 4, "bug_hits": {"1": true}}]`, using action steps starting at zero
before the first action. The same list can be saved as `result.json`'s
`replay_trace` field. Flags are sampled after each action; keep step zero too.
The earliest true sample establishes each hit step. A trace must cover the
whole run to establish first hit timing. The scorer never starts a replay.

Existing saved judge traces contain final flags and state snapshots without
per step hit flags. These do not establish hit timing. Without a timestamped
trace or hand grades, the score explicitly says `flag-only`, leaves
`found_confirmed` and `false_reports` null, and gives the required grades path
in `needs`. True planted `result.json` `bug_hits` ids appear only as
`flags_fired`; they never credit a report or a found bug. A clean build's
confirmed reports are all false reports.

Only fake runs and fake keys are used by `tests/test_i4_bench.py`.
