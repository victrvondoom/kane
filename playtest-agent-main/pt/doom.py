import io
import math
from pathlib import Path

import numpy as np
from PIL import Image
import vizdoom as V

from pt import guard
from pt.adapter import Adapter


KEYS = {"forward": "MOVE_FORWARD", "up": "MOVE_FORWARD", "back": "MOVE_BACKWARD",
        "down": "MOVE_BACKWARD", "left": "TURN_LEFT", "right": "TURN_RIGHT",
        "strafe_left": "MOVE_LEFT", "strafe_right": "MOVE_RIGHT", "space": "USE",
        "e": "USE", "f": "ATTACK", "ctrl": "ATTACK", "attack": "ATTACK"}


class DoomAdapter(Adapter):
    def __init__(self, cfg, game=None):
        if game is None:                                  # the real engine: never beside an open game window
            hold = guard.doom_hold()
            if hold:
                raise SystemExit(hold)
        root = Path(V.__file__).parent
        scenario = cfg["scenario"]
        wad = cfg.get("game_wad", "freedoom2.wad")
        if Path(scenario).name != scenario or not scenario.endswith(".cfg") or not (root / "scenarios" / scenario).is_file():
            raise ValueError("scenario must be a cfg file in the vizdoom scenarios folder")
        if wad != "freedoom2.wad":
            raise ValueError("game_wad must be freedoom2.wad")
        self.cfg = cfg
        self.name, self.controls, self.goal = cfg["name"], cfg.get("controls", ""), cfg.get("goal", "")
        self.shot_width = cfg.get("shot_width", 640)
        self.hold_ticks = cfg.get("hold_ticks", 9)
        self.executed = []
        self._last_shot = None
        self._ticks = 0
        self._frames = None
        self._last_frame = None
        self._map_open = False
        self.game = game if game is not None else V.DoomGame()
        try:
            self.game.load_config(str(root / "scenarios" / scenario))
            self.game.set_doom_game_path(str(root / wad))
            if cfg.get("doom_map"):
                self.game.set_doom_map(cfg["doom_map"])
            self.game.set_window_visible(False)
            self.game.set_sound_enabled(False)
            self.game.set_mode(V.Mode.PLAYER)
            self.game.set_screen_format(V.ScreenFormat.RGB24)
            self.game.set_seed(cfg.get("seed", 1))
            self.game.set_screen_resolution(V.ScreenResolution.RES_640X480)
            self.game.set_sectors_info_enabled(True)
            if cfg.get("map_key"):           # tab shows Doom's own automap: walls seen so far, black ground, red walls
                self.game.set_automap_buffer_enabled(True)
                self.game.set_automap_mode(V.AutomapMode.NORMAL)
                self.game.set_automap_rotate(False)
                self.game.set_automap_render_textures(False)
                self.game.add_game_args("+am_colorset 1 +am_drawmapback 0")
            buttons = self.game.get_available_buttons()
            for name in dict.fromkeys(KEYS.values()):
                button = getattr(V.Button, name)
                if button not in buttons:
                    self.game.add_available_button(button)
            self.buttons = self.game.get_available_buttons()
            variables = self.game.get_available_game_variables()
            for name in cfg.get("vars", []):
                variable = getattr(V.GameVariable, name.upper())
                if variable not in variables:
                    self.game.add_available_game_variable(variable)
                    variables.append(variable)
            self.variables = [getattr(V.GameVariable, name.upper()) for name in cfg["vars"]] if "vars" in cfg else variables
            self.game.init()
            self.game.new_episode()
            # Doors: the sectors shut at the start (ceiling at floor). None when the engine gives no sector data.
            sectors = getattr(self.game.get_state(), "sectors", None)
            self._shut = None if sectors is None else [i for i, s in enumerate(sectors) if s.ceiling_height - s.floor_height < 1]
            self._opened = set()
        except Exception:
            self.game.close()
            raise

    def tick(self):
        return self._ticks

    def start_recording(self, folder):
        self._frames = Path(folder) / "frames"
        self._frames.mkdir(parents=True, exist_ok=True)

    def _frame(self):
        state = self.game.get_state()
        if state is not None:
            buffer = state.screen_buffer
            automap = getattr(state, "automap_buffer", None)
            if self._map_open and automap is not None:
                buffer = automap
            if buffer.shape[-1] != 3:
                buffer = np.moveaxis(buffer, 0, -1)
            image = Image.fromarray(buffer).convert("RGB")
            if self._map_open and automap is not None:      # the map follows the player at the centre: show the middle at 2x
                w, h = image.size
                image = image.crop((w // 4, h // 4, w - w // 4, h - h // 4)).resize((w, h), Image.Resampling.NEAREST)
            self._last_frame = image
        return self._last_frame

    def _save_frame(self, image):
        if self._frames is not None and image is not None:
            image.save(self._frames / f"f{self._ticks:08d}.jpg", quality=80)

    def _advance(self, buttons, ticks):
        if self._frames is None:
            self.game.make_action(buttons, ticks)
            self._ticks += ticks
            return
        self._frame()
        for _ in range(ticks):
            if self.game.is_episode_finished():
                break
            self.game.make_action(buttons, 1)
            self._ticks += 1
            self._save_frame(self._frame())

    def screenshot(self):
        image = self._frame()
        self._save_frame(image)
        if image is None:
            raise RuntimeError("the episode has no screen buffer")
        image = image.resize((self.shot_width, max(1, round(image.height * self.shot_width / image.width))),
                             Image.Resampling.LANCZOS)
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=70)
        self._last_shot = out.getvalue()
        return self._last_shot

    fps = 35

    def execute(self, actions):
        """last_spans: the engine frames of each action (start, keys let go, end), for the run video."""
        self.action_note = ""
        self.last_spans = []
        refused = []
        for action in actions:
            self.executed.append(action)
            span = {"from": self._ticks}
            if self.game.is_episode_finished():
                self.last_spans.append({**span, "held_to": self._ticks, "to": self._ticks})
                continue
            kind = action.get("type")
            if kind == "keypress":
                refused.extend(str(key) for key in action.get("keys", []) if key.lower() not in KEYS and not (self.cfg.get("map_key") and key.lower() == "tab"))
                if self.cfg.get("map_key") and any(key.lower() == "tab" for key in action.get("keys", [])):
                    self._map_open = not self._map_open
                    self._advance([False] * len(self.buttons), 1)
                pressed = {getattr(V.Button, KEYS[key.lower()]) for key in action.get("keys", []) if key.lower() in KEYS}
                if pressed:
                    if self.cfg.get("use_walks") and V.Button.USE in pressed:
                        self._walk_until_blocked()
                    self._advance([button in pressed for button in self.buttons], self.hold_ticks)
                span["held_to"] = self._ticks
            elif kind == "wait":
                ticks = int(action.get("ms", 800) * 35 / 1000)
                if ticks > 0:
                    self._advance([False] * len(self.buttons), ticks)
            span.setdefault("held_to", span["from"])
            span["to"] = self._ticks
            self.last_spans.append(span)
            self._note_doors()               # after every action: a Doom door shuts again about 4 s after it opens
        if refused:
            allowed = sorted(KEYS)
            if self.cfg.get("map_key"):
                allowed.append("tab")
            names = ", ".join(sorted(allowed))
            self.action_note = "; ".join(f"key refused: {key}, allowed: {names}" for key in refused)

    def _walk_until_blocked(self, limit=35):
        """use_walks: use only works when touching, and the picture hides the distance (t-doom2 pressed 93 units short),
        so walk forward a frame at a time until the player stops moving, at most 1 s."""
        forward = [button == V.Button.MOVE_FORWARD for button in self.buttons]
        position = (V.GameVariable.POSITION_X, V.GameVariable.POSITION_Y)
        for _ in range(limit):
            if self.game.is_episode_finished():
                return
            before = [self.game.get_game_variable(v) for v in position]
            self._advance(forward, 1)
            if math.dist(before, [self.game.get_game_variable(v) for v in position]) < 0.5:
                return

    def _note_doors(self):
        sectors = getattr(self.game.get_state(), "sectors", None) if self._shut is not None else None
        if sectors is not None:          # after the episode ends there is no state: keep the last count
            self._opened |= {i for i in self._shut if sectors[i].ceiling_height - sectors[i].floor_height >= 1}

    def state(self):
        out = {**{variable.name.lower(): self.game.get_game_variable(variable) for variable in self.variables},
               "finished": self.game.is_episode_finished(), "dead": self.game.is_player_dead()}
        if self._shut is not None:
            self._note_doors()
            out["doors_opened"] = len(self._opened)    # ever opened: Doom doors shut again after about 4 s
        return out

    def won(self):
        return (self.game.is_episode_finished() and not self.game.is_player_dead()
                and (self.cfg.get("win", "finished") != "kill" or self.game.get_game_variable(V.GameVariable.KILLCOUNT) > 0))

    def fresh(self):
        return DoomAdapter(self.cfg)

    def close(self):
        self.game.close()
