# Native TUI and command guide

Run Relay from the project directory you want the harnesses to edit.

## Open the native workspace

```bash
relay
```

Relay selects the most recent task for the current directory or creates one, then starts its active native TUI.

Inside Codex, Codex owns its composer and slash commands. Inside OpenCode, OpenCode owns them. Relay does not translate `/resume` into `/sessions`, replace `/undo`, or focus a second command dialog. Type commands exactly as you would when launching that CLI directly.

Press `Ctrl+Q` to switch directly to the other harness. `F6` remains the fallback (`Fn+F6` when macOS treats the function row as media keys). Zellij reserves `Ctrl+Q` in its default keymap, so use the fallback there or change Zellij's binding. There is no prefix chord or Relay-owned selector. See the [README terminal notes](../README.md#terminal-shortcuts).

`/harness` is intentionally not intercepted. It is ordinary native composer input, just like every other slash command. Relay cannot distinguish the main composer from native dialogs, Vim state, search fields, history edits, or an external editor by reading raw PTY bytes. Adding a fake text parser would make the native interfaces less reliable.

If a native turn is active, Relay keeps the frontend attached and rings the terminal bell. Retry the switch after the turn becomes idle.

## Check installed harnesses

```bash
relay doctor
```

Relay reports whether each executable is on `PATH` and prints its installed version. Relay does not contact a package registry or mutate global tools during startup.

The project’s scheduled compatibility workflow installs the latest stable Codex and OpenCode and exercises the protocol contract daily. Contributors can run the same no-model-call probe locally:

```bash
bun run compat:latest
```

## Start and select tasks

```bash
relay new "Repair CSV import" --with codex
relay new "Review the API" --with opencode
```

`relay new` records the current directory and selected harness. The native binding is created when the corresponding native workspace opens.

Inspect and select tasks with:

```bash
relay status
relay history
relay list
relay thread <id>
```

`relay thread` accepts a full ID or an unambiguous prefix from `relay list`.

Export a user-readable archive, or delete Relay's copy of a task:

```bash
relay export
relay export <id> --out relay-task.json
relay delete <id> --force
```

Export includes visible canonical conversation text and public task metadata. It excludes native binding IDs, hidden undo state, locks, journals, and secrets, and is not an importable backup. Delete requires `--force`, survives interruption through a private deletion journal, and never removes workspace files or vendor-native sessions.

Tasks are directory-bound. Relay will not run or synchronize a task from a different directory, which prevents an accidental native session from editing the wrong project.

## Run a headless turn

The native workspace is the primary interface, but scripts can run turns directly:

```bash
relay ask "Reproduce the import failure and add a focused test"
relay ask --with opencode "Review the fix for encoding edge cases"
relay ask --with codex --model <model-name> "Apply the useful findings"
```

`--with` chooses the harness for this turn and makes it active. `--model` is forwarded to that harness and remembered on its binding.

Headless turns use the supported non-interactive interface of each CLI. Interactive approvals and questions are best handled in bare `relay`, where the real native TUI is present.

## Switch the next headless turn

```bash
relay use codex
relay use opencode
```

This changes task metadata without running a model. Bare `relay` opens the selected native TUI on the next launch.

## Open a binding without Relay’s live backend

```bash
relay native
relay native opencode
```

This prints a conventional standalone resume command for an existing native binding. It does not execute the command.

Turns made through that standalone process are outside Relay’s live coordination. Relay attempts to import completed turns when it later reattaches through bare `relay`, but the vendor may not expose every out-of-band state transition.

## Choose a data directory

Relay follows `RELAY_DATA_DIR`:

```bash
RELAY_DATA_DIR="$HOME/Library/Application Support/relay" relay
```

The default is `~/.local/share/relay`. It contains visible conversation text and task metadata, so include it in your normal data-protection decisions.

## Exit behavior

Headless commands exit `0` on success and `1` for invalid input, missing state, unavailable harnesses, or failed turns. Bare Relay normally returns the native frontend’s non-zero exit code.

A failed or interrupted harness may have modified files even if Relay could not import a completed response. Inspect the working tree before retrying.

If Relay itself is force-killed, the next launch checks private process-ownership records and stops surviving Relay-owned process groups only when their OS start identity still matches. Arguments, environment variables, capability tokens, and transcript text are never stored in those records.
