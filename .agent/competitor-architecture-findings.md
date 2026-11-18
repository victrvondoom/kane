# Competitor architecture findings

No competitor source code was read in this session (see `competitor-feature-matrix.md`). The only external material consulted was the current Claude Code hooks reference at code.claude.com/docs/en/hooks.

## Verified from the Claude Code hooks reference

- Hooks receive one JSON object on stdin. Common fields include `session_id`, `transcript_path`, `cwd`, `hook_event_name`. Tool events add `tool_name`, `tool_input` (for Edit and Write, `tool_input.file_path`).
- Exit code 2 blocks the action on blocking events. For `Stop`, stderr is fed back to Claude and the turn continues.
- A `PreToolUse` deny is returned as stdout JSON: `hookSpecificOutput.permissionDecision = "deny"` with `permissionDecisionReason`, exit 0.
- `Stop` decision schema (`decision`, `reason`) was documented in the reference but its input section (including whether `stop_hook_active` exists) was not visible to the fetch tool. The implementation therefore does not depend on `stop_hook_active`; it bounds retries with its own per-turn counter.
- Settings live in `.claude/settings.json` (shared), `.claude/settings.local.json` (per user), or `~/.claude/settings.json`.

## Implications adopted

- Block with exit 2 and a precise stderr message (not JSON), so the feedback reaches the agent verbatim. Confirmed in a real transcript.
- Default to `settings.local.json`, which is git-ignored, so the gate is not imposed on teammates unless `--shared` is used.
