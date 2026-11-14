# Who wrote the holdout game

Lantern Rooms (`bench/holdout/game/index.html`) and its sealed key were written on 28 Oct 2026 by the same build session
that built the agent and wrote its prompt. So the author had seen the prompt. The game was not written by a separate session.

What keeps the test fair:
- The agent prompt and every player and judge setting were frozen when the game was done (`PROMPT-FREEZE.json`, checked by
  `tests/test_prompt_freeze.py`). Nothing in them may change until the holdout bench run.
- The bench runner and scorer were written by a different worker that never read the sealed key.
- The worker lanes that run the main suite never see the key: the holdout tests live here, not in `tests/`.

The RESULTS row for the holdout bench must say this in plain words: who wrote the game, and that the author had seen the prompt.
