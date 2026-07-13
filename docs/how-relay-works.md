# How Relay keeps context

Relay coordinates a task; it does not replace either coding harness. Its TUI is the stable outer workspace, while Codex and OpenCode remain the engines that inspect files, use tools, and produce each turn. The interface can look and speak like either harness without changing which engine runs underneath.

## Harness, skin, and commands

Relay keeps three choices separate:

- **Harness:** the installed Codex or OpenCode process that receives the next turn.
- **Skin:** the Codex- or OpenCode-compatible layout, labels, and command vocabulary shown by Relay.
- **Command behavior:** the verified implementation used for a semantic action such as compact or review.

The skin follows the harness by default. Pinning a skin lets you keep, for example, OpenCode's interface while Codex handles the task. The actual harness is always labeled beside the composer so visual familiarity never hides which process can edit the workspace or contact a provider.

Command names are resolved to actions before Relay dispatches them. That is why OpenCode `/sessions` and Codex `/resume` can open the same Relay task picker. When an action truly belongs to one harness, Relay leaves it visible but disabled over the other harness and explains what must change. Per-command overrides are offered only when Relay has a working adapter for each choice.

## One task, two native sessions

Each Relay task has three small pieces of state:

- a canonical sequence of user and assistant messages;
- the working directory for the task;
- an optional native session ID and synchronization cursor for each harness.

The native bindings are lazy. Starting a task with Codex does not launch OpenCode or create an empty OpenCode session. The OpenCode binding appears only when OpenCode receives its first turn. Changing the skin alone never starts either harness.

When a harness runs again, Relay resumes its native session. When the other harness has added messages since that session last ran, Relay adds those missing messages as a structured handoff before the current request. It never resends messages that the target harness has already received.

## What crosses the boundary

Relay transfers the visible conversational contract:

- your requests;
- final assistant responses;
- which harness produced each response;
- the order in which they occurred.

The shared working directory carries the actual code changes. The receiving harness is explicitly told to inspect current files before acting, because another harness may have changed them.

Relay intentionally does not copy hidden reasoning, raw terminal output, tool call payloads, provider cache entries, or private harness metadata. Those details are often large, vendor-specific, sensitive, and less reliable than the workspace itself.

While a turn runs, supported text events can appear immediately in the TUI. This partial view lives only in process memory. On success, Relay replaces it with the single canonical response; on failure, it discards it and restores the user's draft.

## The native sessions are real

Relay invokes the supported Codex and OpenCode CLIs and records their returned session IDs. Subsequent turns resume those IDs. Run `relay native codex` or `relay native opencode` to print the corresponding native resume command.

The Relay timeline remains the cross-harness source of truth. If you open a native session and add turns directly there, Relay does not automatically import those new turns in v0.1. Returning to Relay will resume the session, but its canonical history will not know about that out-of-band dialogue.

## Why this stays small

Relay uses append-only JSON Lines for canonical messages and a small JSON metadata file per task. It does not mirror the Codex or OpenCode databases. The TUI is one foreground process. A harness process starts only for discovery or an operation that needs it, and exits when that operation finishes; Relay never keeps both harnesses warm in the background. Harness output is parsed as a stream, and Relay persists only the final response, session ID, and synchronization cursor. A bounded diagnostic tail and the visible conversation window exist in memory only while Relay runs.

Relay creates its directories for the current user only (`0700`) and transcript files as private (`0600`) on Unix-like systems. Existing Relay files are tightened when read or rewritten.

By default, data lives at:

```text
~/.local/share/relay/
  index.json
  threads/
    <relay-task-id>/
      thread.json
      events.jsonl
```

Set `RELAY_DATA_DIR` to use another location.

## Prompt caching

Provider prompt caches reward stable prefixes. Relay's warm path resumes the existing native session and appends only new messages, which preserves that shape better than rebuilding an entire prompt in a different order every turn.

The cold path must send the prior canonical conversation once because the target harness has never seen it. After that, only deltas are sent. Cache entries remain local to their provider, model, account, and cache policy; Relay cannot move a Codex cache into an OpenCode provider.

## Honest boundaries

Relay provides conversation continuity, not identical internal state.

- A receiving harness sees the prior visible dialogue and current workspace, not another harness's hidden reasoning or tool trace.
- A handoff is represented inside the native session as structured context attached to the next user request.
- Provider context windows and compaction policies still apply.
- The compatibility skins provide Relay's common workspace and familiar command vocabulary; they do not embed or copy either project's native TUI implementation.
- A failed native turn is not committed to the canonical Relay history, but the native harness may already have edited files before it failed. Inspect the workspace before retrying.
- Successful turns use a recoverable pending-turn journal before the canonical log and binding are advanced. Relay repairs a stale metadata cursor or incomplete final JSONL line when reopening a task.
- An abrupt process or machine stop after a harness advances but before Relay journals its result can still leave the native session or workspace ahead of canonical history. Inspect the workspace and native session before retrying after an interrupted turn.
- A second writer to the same task is rejected while a turn is running.

These boundaries keep Relay compatible with supported CLI interfaces and avoid fragile writes into vendor-owned storage.
