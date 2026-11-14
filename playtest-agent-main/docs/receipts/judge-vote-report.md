Temperature 0 met the stability requirement on all three checks. Every run returned true8 7 of 8, neg8 0 of 8, and false6 0 of 6. All 22 report verdicts were identical across the three JSON receipts. Step 2 was not needed.

The tiny Spark call returned HTTP 200 with low reasoning. Its response reported temperature 0.0 and completed with OK. It cost $0.00064700. See [the smoke receipt](judge-vote-smoke.json).

| Run | true8 | neg8 | false6 | Cost USD | Receipt |
| --- | --- | --- | --- | --- | --- |
| 1 | 7/8 | 0/8 | 0/6 | $0.12554410 | [JSON](judge-vote-temp-run1.json) |
| 2 | 7/8 | 0/8 | 0/6 | $0.10800775 | [JSON](judge-vote-temp-run2.json) |
| 3 | 7/8 | 0/8 | 0/6 | $0.12886240 | [JSON](judge-vote-temp-run3.json) |

3 of 3 runs met every bar. Evaluation cost was $0.36241425. Total cost including the tiny call was $0.36306125, below $1.50. Costs sum the metered model calls. Every call used a ledger in this worktree with a $1.49 cap.

Each check executed trials/judge_eval.py through runpy with browser replay and lock acquisition replaced by an immediate BLOCKED stop. No browser was started and no check printed BLOCKED. Each receipt contains all 22 report rows. Saved trace hashes matched before and after each check. The existing judge evaluation receipt was restored after each run.

Comparison keyed every row by set and report id and compared judge_yes, confirmed, and incomplete. All matched across all three runs. Evidence wording varied. All 66 judgments completed without incomplete answers. The true8 report hunt2:2 remained unconfirmed in every run; its saved replay is marked not reproducible.

The 22 traces are both tune and test set. These checks do not measure generalization or guarantee that future calls will always agree.

The prompt, false claims, and bars are unchanged. No title specific rules were added. The only judge behavior change is temperature 0 on the initial call and any existing retry.

Tests were changed first and observed to fail in two temperature assertions, with 17 tests passing. After the code change all 19 judge tests passed. Python 3.13.13 was used. The suite command python -m pytest --ignore=tests/test_game.py passed with 129 tests passed and 3 skipped. Browser tests were excluded to keep this job free of browser activity. The prompt was also compared with HEAD and found identical.
