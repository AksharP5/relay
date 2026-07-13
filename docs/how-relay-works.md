# How Relay keeps context

Relay coordinates native coding harnesses; it does not replace their interfaces or internal state.

## Native frontend, temporary backend

For Codex, Relay starts an authenticated local `codex app-server`, then runs the upstream Codex TUI with its remote-session flags. For OpenCode, Relay starts an authenticated local `opencode serve`, then runs the upstream `opencode attach` TUI.

The frontend runs in a real pseudo-terminal. Relay passes its bytes directly between the child and your terminal, so the upstream application owns rendering, slash commands, approvals, mouse input, keyboard behavior, and dialogs.

Relay keeps only one harness stack alive:

1. Start the selected backend.
2. Attach the selected native frontend.
3. When an idle user requests a switch, stop that frontend.
4. Import completed turns and stop its backend.
5. Start and attach the destination stack.

Native sessions are persisted by their own harnesses, so stopping the temporary backend does not discard a materialized conversation.

## Why the switch chord has a prefix

Relay does not intercept `/`, `Escape`, `Ctrl+C`, or ordinary text. It reserves `Ctrl+]`, then `R`, similar to a terminal multiplexer prefix.

The input router recognizes legacy control bytes and the enhanced CSI-u keyboard encoding used by modern terminals. It also understands bracketed-paste boundaries, including markers split across input chunks, so pasted control characters cannot accidentally switch harnesses. If `Ctrl+]` is not followed by `R`, Relay forwards it to the native application after a short timeout.

Switching is allowed only while the current native session reports idle. During a busy or retrying turn, Relay leaves the frontend connected and sounds the terminal bell. This preserves live output and interactive approval state.

## One task, two native bindings

A Relay task contains:

- an append-only sequence of completed visible user and assistant messages;
- the working directory;
- the active harness;
- an optional native thread/session ID, model, synchronization sequence, and native cursor for Codex and OpenCode.

Bindings are lazy. A cold Codex task opens the base native TUI and lets Codex create its own thread on the first real turn. This matters because Codex does not persist a newly started empty app-server thread. When a cold Codex session already has a cross-harness handoff, Relay starts the thread and injects that handoff on the same app-server connection before closing it, making the session safely resumable.

OpenCode can create and persist an empty session before the attached TUI starts.

## The synchronization sequence

Before opening a bound destination, Relay:

1. reads completed native turns and imports any it has not seen;
2. reads canonical messages after the destination binding’s `lastSyncedSeq`;
3. injects that delta without asking a model to respond;
4. advances the synchronization cursor only after injection succeeds;
5. launches the native frontend.

After the frontend exits, Relay resolves the session that was actually active, imports completed turns idempotently using native turn IDs, and performs one final delta check.

If native `/new`, `/resume`, or session navigation moves to another materialized session, Relay rebinds the current task and avoids reinjecting messages already present in that native transcript. A selection that produces no server-visible activity can be impossible to distinguish from the prior session; Relay keeps the previous binding rather than guessing.

## What is injected

Relay transfers completed visible text:

- user requests;
- final assistant responses;
- their ordering and originating harness.

OpenCode receives a `noReply` synthetic text part, which its TUI does not render as ordinary user input. Codex receives raw structured message items through `thread/inject_items`. Neither path starts a turn or consumes a separate model response.

The following do not cross:

- hidden reasoning;
- raw terminal bytes;
- tool call payloads and approval state;
- attachments;
- provider cache entries;
- vendor-specific metadata and databases.

The working directory carries file changes. A destination harness should inspect current files rather than assuming the text transcript completely describes the workspace.

## Bounded context and compaction

Relay scans its JSON Lines log and retains at most 200 messages and 120,000 characters for a cold or long-idle handoff. Individual oversized messages are tail-truncated and the oldest messages are omitted first. This creates a predictable memory ceiling and leaves room in the destination model’s context.

Relay does not run an automatic summary model. Such a shadow summarizer would add latency, inference cost, another failure mode, and new context that neither user authored nor native harness produced.

Native compaction remains native. A Codex or OpenCode compaction changes that harness’s internal context but does not erase Relay’s canonical visible log. If the next native request encounters a context-window error, the selected TUI displays and handles it according to its own release.

## Prompt caching

Warm native sessions preserve their existing prefix. Relay appends only missing cross-harness dialogue, which is friendlier to exact-prefix provider caches than rebuilding the entire prompt every turn.

Caches remain provider-, model-, account-, and policy-specific. Relay cannot move a Codex cache entry into an OpenCode provider. It only avoids needless prompt reshaping.

## Local storage

By default:

```text
~/.local/share/relay/
  index.json
  threads/
    <relay-task-id>/
      thread.json
      events.jsonl
```

Relay creates directories with mode `0700` and files with mode `0600` on Unix-like systems. Message storage is append-oriented and recoverable through a small pending-turn journal. Reads stream and bound the retained window rather than loading an unlimited transcript into memory.

Set `RELAY_DATA_DIR` to use another location.

## Failure behavior

- A second writer to one task is rejected while a storage transition is running.
- A task cannot run from a different working directory without explicit selection or creation there.
- Binding and synchronization cursors advance only after confirmed operations.
- A failed native turn may still have edited files; Relay does not pretend the workspace rolled back.
- Abrupt machine or process termination can leave a vendor session or workspace ahead of canonical history. Relay imports completed native turns on the next attachment when the upstream API exposes them.
- Relay never silently approves a native request. The real TUI remains the interactive client.

## Why cross-pairing is not a skin setting

OpenCode’s TUI speaks OpenCode’s HTTP/SSE protocol and assumes OpenCode session, message, tool, permission, and command schemas. Codex’s TUI speaks the Codex app-server protocol and assumes Codex thread, turn, item, approval, and configuration schemas.

Making the literal OpenCode binary control Codex would require a stateful protocol adapter implementing the full server expected by OpenCode while translating every operation and stream to Codex, and the reverse for a Codex TUI over OpenCode. A visual theme cannot do that.

Relay’s first release therefore guarantees native matched pairs and a common switch/context layer. Cross-pairing can be added only when the protocol translation is complete enough to preserve commands, approvals, tools, cancellation, recovery, and streaming—not merely the home screen.
