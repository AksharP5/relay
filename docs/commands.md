# TUI and command guide

Run Relay from the project directory you want the harnesses to edit. Relay refuses to run a turn when the current directory differs from the task's saved directory.

## Open the workspace

```bash
relay
```

Bare `relay` opens the persistent TUI. Type a request and press `Enter`. Use `Ctrl+R` to select Codex or OpenCode without closing the interface; the selection applies to the next submitted turn. `Shift+Enter` inserts a newline and `Ctrl+C` exits.

Opening an empty workspace does not create a task. Relay creates it from the first request, using the current directory and selected harness.

The remaining commands are useful for diagnostics, scripting, and task management. They operate on the currently selected Relay task.

## Check your setup

```bash
relay doctor
```

Relay reports each CLI independently. You can use Relay with one installed harness, but switching requires both.

## Start a task

```bash
relay new "Repair CSV import" --with codex
```

`relay new` records the current directory. It does not launch a harness until the first `relay ask`.

If you run `relay ask` before `relay new`, Relay creates a task automatically using the current directory and a title derived from the request.

## Run a turn

```bash
relay ask "Reproduce the import failure and add a focused test"
relay ask --with opencode "Review the fix for encoding edge cases"
```

`--with` selects the harness for this turn and makes it active for later turns. `--model` is forwarded without translation:

```bash
relay ask --with opencode --model anthropic/claude-sonnet-4-5 "Review this"
```

An explicit model becomes part of that harness's native binding. Later turns reuse it unless another `--model` value replaces it.

Quote multi-word messages so your shell passes them as one request.

## Switch without running a turn

```bash
relay use codex
```

The target native session is still created lazily on its first actual turn.

## Inspect or change tasks

```bash
relay status
relay history
relay list
relay thread 8efbcd50-e70a-4552-a8af-8314dea50547
```

`relay thread` accepts the short ID displayed by `relay list`. If two tasks share that prefix, provide more characters from the full ID stored in the task metadata.

`relay list` includes each task's saved working directory so similarly named tasks can be distinguished.

## Open a native session

```bash
relay native
relay native opencode
```

This prints, but does not execute, the native resume command. Relay does not automatically import turns made directly in the native app.

## Choose a data directory

Relay follows `RELAY_DATA_DIR` when it is set:

```bash
RELAY_DATA_DIR="$HOME/Library/Application Support/relay" relay status
```

The default is `~/.local/share/relay`. The directory contains conversation text, so include it in your normal local data protection and backup decisions.

Relay does not yet have a per-task delete command. To remove all Relay metadata and canonical transcripts, delete the Relay data directory while Relay is not running. Native Codex and OpenCode sessions are separate and are not deleted with Relay data.

## Exit status

Relay exits with status `0` after a successful command and `1` after invalid input, missing state, a missing harness, or a failed native turn. Native error details are printed to standard error when available.

The native harness receives a 30-minute process timeout. A failed or timed-out harness may have changed files even though Relay does not add the turn to canonical history; inspect `git status` and the workspace before retrying.
