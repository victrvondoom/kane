# Playtest Agent

Version 0.9.0.

Playtest Agent plays a web game from screenshots, looks for bugs, and checks its reports with replay.

Solo developers and small studios often have no one to playtest a build. This tool plays from the title screen, checks reported problems, and shows the evidence.

## How it works

1. **Play.** A model sees a screenshot and picks keys or clicks through a function tool.
2. **Report.** During play, it records what it expected and what it saw.
3. **Replay.** Each report is replayed twice on a fresh game copy. Reports that do not reproduce are set aside.
4. **Judge.** A second model gets a filmstrip of recent actions and the game state change. It must answer yes or no and quote evidence. A yes without a quote counts as no.
5. **Report page.** Each run has an HTML page with screenshots, bug cards, evidence, verdicts, and cost.

## Quick start

### See it without a key

This repo holds one real finished run, so you can look before you set anything up. It needs no key, no install and $0.
It is a bug hunt on Cave Courier: 6 of 6 reports confirmed, and they cover all 5 planted bugs.

```
git clone https://github.com/Midknight56/playtest-agent
cd playtest-agent
```

Then open `samples/h12/report.html` in a browser. The page links to `samples/h12/console.html`, which steps through
the run one screenshot at a time.

`samples/pf-hunt-1/` holds the saved files of one blind hunt on my released game Purrfect Fit 1.2.5: `result.json`, `confirm.json` and the replay pictures. It has no report page.

### Run it yourself

You need Python 3.12 or newer, a Meta Model API key, and Chromium for Playwright. It runs on Windows, macOS and Linux.
Check with `python3 --version` (on Windows, `python --version`). The python3 that comes with macOS is too old: run
`brew install python@3.12`, then use `python3.12` for the venv step below.

Make a virtual environment and turn it on. On Windows:

```
python -m venv .venv
.venv\Scripts\activate
```

On macOS or Linux:

```
python3.12 -m venv .venv
source .venv/bin/activate
```

If `python3 --version` already says 3.12 or newer, `python3 -m venv .venv` works too. Inside the venv, `python` is the right one.

On Ubuntu or Debian, run `sudo apt install python3-venv` first if the venv step says ensurepip is not available.

Set your key in the shell you use:

| Shell | Line |
| --- | --- |
| PowerShell | `$env:MODEL_API_KEY = "your key"` |
| Command Prompt | `set MODEL_API_KEY=your key` |
| macOS or Linux | `export MODEL_API_KEY="your key"` |

With no key, a paid command stops at once with one line and spends nothing.

Then:

```
pip install -r requirements.txt
python -m playwright install chromium
python -m pt guard
python -m pt goal first-run
python -m pt hunt first-hunt
python -m pt confirm data/runs/first-hunt
python -m pt report data/runs/first-hunt
```

On Cave Courier, `pt hunt` turns the 5 planted bugs on by default. Add `--clean` for the build with every planted bug off.

On Linux, use `python -m playwright install --with-deps chromium` for the second line: it also installs the browser's system libraries (it asks for sudo).

ffmpeg is optional. You need it only for run videos and for `--judge-input video`. Its tests skip when it is missing.

| System | Line |
| --- | --- |
| macOS | `brew install ffmpeg` |
| Ubuntu or Debian | `sudo apt install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |

`pt.guard` checks the machine before a run. Runs are headless. If it reports a busy GPU or an open game window, close it, or add `--allow-gpu` or `--allow-game-window` to the run. On the test game our goal runs cost $0.16 to $0.49 and our hunts $0.99 to $1.28. Every run stops once it reaches its own cap (`--max-usd`, 2.5 by default). The run cap is checked before each call, so the last call can go a little over (one run spent $0.5457 on a $0.50 cap). The shared total cap below is different: it reserves each call's worst case before sending.

### Hunt on the public chess game

You need Node and npm. This setup was checked with Node v24.16.0 and npm 11.13.0.
`fetch_games.py` downloads every game listed in the pinned manifest. The build installs the pinned npm packages and bundles the chess game.

```
python tools/fetch_games.py
python tools/build_chess.py
python -m pt hunt chess-hunt --game react-chess
```

The hunt needs a Meta Model API key. Our hunt of 60 steps cost $1.6767.

### Slay the Spire 2 needs your own copy

The repo holds no game files. You need your own copy from [Steam](https://store.steampowered.com/app/2868840/).
The repo has the input mod (`mods/pt_input`), the fix mod (`mods/pt_fix`), two example configs (`games/sts2-example.json`, `games/sts2.fix.example.json`) and their build tools (`tools/build_sts2_mod.py`, `tools/build_sts2_fix.py`). It holds no game files and no game source. The saved runs of this game are in the release.

## A Doom engine game (Freedoom)

Install ViZDoom with `pip install vizdoom`. On an Intel Mac, pip builds it from source, so run `brew install boost sdl2 pkgconf game-music-emu` first. This adapter uses a Doom engine game (Freedoom) with the Freedoom data shipped in the package. It runs with no window. The engine waits for each action.

```
python -m pt goal d01 --game freedoom
```

## Private mode

Private mode runs the whole agent on one gaming PC with Muse Glimmer open weights. Nothing leaves the machine. It needs no API key or spend ledger. Use a local game build.

How well it does, from [RESULTS](docs/RESULTS.md#a-phone-game-private-mode-cost-and-the-api):

- Glimmer as the judge agreed with Spark on 19 of 22 verdicts, on one PC ([the judge row](docs/RESULTS.md#a-phone-game-private-mode-cost-and-the-api)).
- Glimmer as the player did not find the planted bugs on Cave Courier: 0 of 4 runs with bugs, and no false report in 2 clean runs. It fell into the pit early and never jumped, even with its position given as text ([the state text test](docs/RESULTS.md#glimmer-with-the-state-text-a-setting-test-not-the-frozen-result)). Use Wonder to play when the build may leave the machine, and Glimmer to judge when it may not.

You need `llama-server` from llama.cpp (we used build b11936, github.com/ggml-org/llama.cpp) and two Muse Glimmer 30B files: `Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf` and `mmproj-Muse-Glimmer-30B-Q4_K_M.gguf`. Start it yourself from the folder that holds them. The agent does not start the server. On our PC with a 16 GB graphics card, the server held 15.4 GB on the card and 14.6 GB of memory, and it needed about 23 GB free before it started.

```
llama-server -m Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf --mmproj mmproj-Muse-Glimmer-30B-Q4_K_M.gguf -ngl 40 -c 16384 -np 1 -t 16 --host 127.0.0.1 --port 8090
```

```
python -m pt hunt private --model glimmer-local
python -m pt confirm data/runs/private --model glimmer-local
python -m pt resume private --note "Continue"
```

Use `--glimmer-url http://127.0.0.1:8090/v1` to select the local server. Use `--reasoning low`, `medium`, or `high` to set reasoning. Resume keeps the saved model unless you pass `--model`. The saved comparison on 22 judge traces is `docs/receipts/judge-glimmer.json`. The traces are not in this repo or in the release, so you can read that result but not run it again. The server's support for the reasoning field still needs verification.

### Optional: Muse Spark Open as the judge

This path needs your own Fireworks key in `FIREWORKS_API_KEY`. On 49 saved cases, Muse Spark Open gave the same verdict as Muse Spark on 48. It got 44 right against Spark's 45, with 1 miss and 4 false alarms, and 24 of 116 calls failed (see Results). To judge 27 of those cases again, unzip the release's `pc2-react-chess`, `sts2-room-g-3`, `sts2-room-g-decoy-1b`, `sts2-room-g-decoy2-1`, `ho1` and `ho1-clean` zips into `data/runs/`, then run this. With no key it prints one line and spends nothing.

```
python -m trials.fireworks_judge --tag mine --sets chess,sts2,holdout
```

## Add your game

A web game needs one JSON file in `games/`. It names the page, viewport, controls, and optional JavaScript that reads game state. See `games/cave-courier.json`.

Four public web games also run from one JSON file each, with no new Python: 2048, Hextris, Tetris and Breakout. `python tools/fetch_games.py` downloads them. One goal run each won a small goal and filed 0 reports (see Results).

```
{
 "type": "web",
 "name": "My Game",
 "url": "http://127.0.0.1:8000/",
 "viewport": {"width": 800, "height": 600},
 "controls": "Arrow keys move. Space jumps.",
 "goal": "Reach the exit.",
 "state_js": "window.__state()"
}
```

A game that is not a web page can use a small Python class with `screenshot`, `execute` and `close` methods. The agent loop, replay, judge, and report page stay the same.

Keep private games out of git. Put their config in `games.local/`, which is ignored.

## Run console, checklist, unverified, escalate, sign off

Run `python -m pt console data/runs/demo` to write `console.html`. Open it to step through screenshots, model text, tool calls, cost, and latency. Use Previous, Next, Play to end, or the arrow keys.

Add `--checklist` to `hunt` or `goal` to ask for a checklist before play. Each tick records evidence and a step.

New reports are unverified. Run `python -m pt confirm data/runs/demo` to check them. A report is confirmed only when replay and the judge both pass. Other checked reports are rejected.

The model can escalate a question to a person when the run starts with `--escalate` (off by default). The run stops and saves `needs_human.json`. Continue with `python -m pt resume demo --note "Try the left door"`. This replays the saved actions and keeps earlier reports and checklist items. The usual caps flags also work with resume.

Run `python -m pt signoff data/runs/demo --by "Sam" --note "Reviewed"` after every report is checked. This saves the reviewer name, note, time, and counts. The report page shows who signed off and links to the console when it exists.

## Spend cap

Every model call reserves its worst case cost before it is sent. The actual cost is recorded after it returns. Standard mode only.

## Results

The saved runs behind the video, Slay the Spire 2, chess and the second test game are in this repo release.

The test game is Cave Courier, a small platformer with five planted bugs. The final checks used the same 22 traces to tune and check the judge, so they are not a holdout.

| Check | Final result |
| --- | --- |
| Judge on true reports | 7 of 8 |
| Judge on negative controls | 0 of 8 |
| Judge on false claims | 0 of 6 |
| Same judge verdicts across four runs | Yes |
| Goal runs, screenshots only, minimal effort | 8 wins in 9 runs |
| Goal run cost | $2.55 total; worst run $0.49 |
| Median time per step, stored chain | About 10.7 seconds; 8 second bar missed |
| Median time per step, own history (now the default) | 1.88 seconds over 5 runs; 4 of the 5 won; 8 second bar met |
| Hunts h01, h02, h03 (first hunt text) | 2, 2 and 2 of 5 planted bugs confirmed (h03 was 3 before the final code) |
| Hunt h10 (method text, before the frame lock) | 4 of 5 planted bugs confirmed |
| Hunt h11 | 5 of 5 planted bugs confirmed; 8 of 9 reports confirmed |
| Hunt h12 (same game, new art) | 5 of 5 planted bugs confirmed; 6 of 6 reports confirmed |
| Clean hunts c01, c02, c10, c11 | 0 false confirmed (c10 filed 2 reports, both rejected) |
| Second game config | 10 JSON lines and 0 code lines; 150 line bar met |
| Second game run | 30 steps, $0.27; reached the first scene from the title |
| Four public web games, one goal run each, state text on | 2048: 12 steps, $0.23. Hextris: 5 steps, $0.08. Tetris: 10 steps, $0.30. Breakout: 2 steps, $0.02. All won; 0 reports |

The hunt bar was 4 of 5 planted bugs in at least two of three buggy hunts, with no false confirms. The first three hunts missed it. After a hunt method in the prompt, a reload action and a frame lock (the game runs a frame only when the harness asks, so replays match), h11 and h12 both found 5 of 5. The bar is met. These fixes were made after looking at the failed hunts, and every hunt was confirmed again with the final code (4598759 and 3a0bd22), so this is not a holdout either. Before two of the fixes, clean hunt c10 had one false confirm ("pit traps player"); it now gets 0. A max output setting of 700 gave step times of 9.9 and 10.6 seconds, still above the 8 second bar.

## More commands

| Command | What it does | Model cost |
| --- | --- | --- |
| `python -m pt replay-check data/runs/first-hunt --times 2` | Judges each report on separate fresh replays | Paid |
| `python -m pt fix-any data/runs/chess-hunt --report 0 --fix-config games/react-chess.fix.json` | Asks the model for a patch for one saved report on a copy of the game, then checks that build with the saved replay. It can fail, and the result says so. It needs a fix config. It needs a report that passed `pt confirm` or `pt replay-check` and has no saved fix yet. | Paid |
| `python -m pt regress data/runs/first-hunt --bugs 1,2,3 --name after` then `python -m pt gate data/runs/after` | Replays checked reports on a build and prints pass or fail. `--bugs` names the planted bugs that stay on in the replay | Regress paid, gate free |
| `python -m pt issues data/issues-first data/runs/first-hunt --no-model` | Groups confirmed reports into proposed issues | Free with `--no-model` |
| `python -m pt diary data/runs/first-run` | A first person playtest diary from a saved run | One model call |
| `python -m pt deathmap data/runs/first-run --ground-y 250` | Replays saved runs and maps where players went and where lives ended. 250 is Cave Courier's ground line. Without the flag it stops with "Give --ground-y" | Free |
| `python -m pt persist save-check` | Checks saved progress after the browser closes | Free |
| `python -m pt contract-draft exit-rule --rule "Reaching the exit sets won to true" --keys-from data/runs/first-run` then `python -m pt contract-approve exit-rule --by Sam` then `python -m pt contract-check exit-rule data/runs/first-run` | Drafts a rule. A person reviews and approves it, then it is checked on saved actions | Draft paid, others free |
| `python -m pt exploit-rule shop-rule` then `python -m pt exploit-approve shop-rule --by Sam` then `python -m pt exploit-search shop-rule --game shop-fixture` | Writes a rule for the shop fixture. A person reviews and approves it, then the model searches for a repeatable gain | Search paid, others free |
| `python -m pt hostile-judge signs --path-run data/runs/first-run` then `python -m pt hostile-score data/runs/first-run` | Probes the judge with signs using a clean winning goal run, then scores saved player responses to signs | Judge paid, score free |
| `python -m pt duo two-players` | Two players take turns on one frame locked page | Paid |
| `python -m pt reduce data/runs/first-hunt --name shorter` | Finds a shorter replay of confirmed reports | Free without `--judge` |
| `python -m bench.run holdout --name my-run` | The holdout bench. See `bench/README.md` | Paid |

## Limits

- The test game is small and written for this project. Real games are harder.
- A problem that is not visible on screen or in game state cannot be confirmed.
- The step time bar was met with five goal runs on the test game only.
- The hunt bar was met on the same game the fixes were made for.

## Licence

MIT. See `LICENSE`.

Slay the Spire 2: https://store.steampowered.com/app/2868840/
