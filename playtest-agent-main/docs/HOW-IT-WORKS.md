# How it works

## The parts

| Part | File | Job |
| --- | --- | --- |
| Game hook | `pt/adapter.py`, `games/*.json` | Opens the game, takes screenshots, runs actions, reads state. One JSON file for a web game, or a small class |
| Agent loop | `pt/loop.py` | Sends a screenshot to Muse Wonder, runs the actions it picks, repeats. Stops on a win, a step limit, a time limit, a cost limit or low memory |
| Replay | `pt/replay.py` | Runs the recorded actions on a fresh copy of the game. Does it twice to check the game repeats itself |
| Judge | `pt/judge.py` | Builds a filmstrip and a state change, asks Muse Spark for a yes or no with quoted evidence |
| Confirm | `pt/confirm.py` | Runs replay and judge for every report in a run and writes `confirm.json` |
| Report page | `pt/report.py` | Turns a run folder into one HTML page |
| Guard | `pt/guard.py` | Refuses to start a browser when the machine is busy |
| Ledger | `metaclient/ledger.py` | A spend cap in code. Reserve before a call, settle after |

## The loop

The agent has two tools. `act` takes a short list of actions: key presses (held for a quarter of a second), waits, clicks. `report_bug` takes a title, what was expected and what was seen. After each `act` call the tool sends a new screenshot. If the game gives a state (coins, score, position), it can be sent as text too (`--state`).

Muse Wonder has a native computer tool in Meta's documentation. It was not available for the key used in these tests (HTTP 400), so actions go through a function tool. The shape of the actions follows the same document.

If the server loses its stored copy of the conversation, the loop sends the whole history again and carries on.

## Why a replay

A model can describe a bug that never happened. The tool only files a bug after it has seen the same actions give the same result twice on fresh copies of the game, and a second model call has quoted evidence from the filmstrip or the state.

For this to work the game has to repeat itself. That means:
- one game step per animation frame, not per millisecond, so the speed of the machine does not matter
- no random numbers, or a fixed seed
- the adapter holds keys for a number of game frames when the game exposes a frame counter (`frame_js` in the config); otherwise it holds them for a quarter of a second

A game that does not repeat itself still works for goal runs and hunts. Its reports show up as "Not reproducible".

## Adding a game

A web game:

```
{
 "type": "web",
 "name": "My Game",
 "serve": {"dir": "path/to/the/built/game", "path": ""},
 "viewport": {"width": 800, "height": 600},
 "ready_js": "document.readyState === 'complete'",
 "state_js": "window.__state()",
 "won_js": "window.__won === true",
 "controls": "Arrow keys move. Space jumps.",
 "goal": "Reach the exit."
}
```

Only `type`, `name` and a page (`url` or `serve.dir`) are required. `serve` starts a local static server on 127.0.0.1 for a built game.

Any other kind of game: subclass `Adapter` in `pt/adapter.py` and give it `screenshot`, `execute` and `close`. Add `state`, `won` and `fresh` if you can.

## Keeping private games private

Everything the tool sends to a model is a screenshot, and state text if you turn it on. Do not point it at a game you are not ready to show a model provider. Put the config of such a game in `games.local/`, which git ignores.

## Safety on a shared machine

- Runs are headless.
- `pt guard` blocks a run if the GPU is above 40%, a ComfyUI queue is busy, a game window is open, free memory is under 8 GB, or another run holds the lock.
- A running run stops by itself if free memory falls under 8 GB.
