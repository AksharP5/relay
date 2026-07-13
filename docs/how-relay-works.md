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

## Why switching uses distinct keys

Relay does not intercept `/`, `Escape`, `Ctrl+C`, or ordinary text. `Ctrl+Q` is the primary direct switch and `F6` is the fallback. Relay has no prefix chord or selector.

The input router recognizes the legacy `Ctrl+Q` control byte, function-key sequences, CSI-u and Kitty enhanced keyboard encodings, and xterm's modified-key form. It consumes only a key press, not a repeat or release. Relay also understands bracketed-paste boundaries, including markers split across input chunks, so pasted shortcut bytes cannot accidentally switch harnesses. Every other key sequence is forwarded to the native application.

Relay does not implement `/harness` by watching for those characters. At the PTY boundary, the same bytes could belong to a native composer, dialog, search field, Vim command, recalled history entry, or external editor. Only the upstream TUI knows that state. OpenCode can register a local plugin command, but stock Codex currently has no equivalent host-command extension point, so a clean command cannot be offered consistently across both native TUIs.

Switching is allowed only while the current native session reports idle. During a busy or retrying turn, Relay leaves the frontend connected and sounds the terminal bell. This preserves live output and interactive approval state.

## One task, two native bindings

A Relay task contains:

- an append-only sequence of completed visible user and assistant messages;
- the working directory;
- the active harness;
- an optional native thread/session ID, model, synchronization sequence, and native cursor for Codex and OpenCode.

Bindings are lazy. A cold Codex task opens the base native TUI and lets Codex create its own thread on the first real turn. This matters because Codex does not persist a newly started empty app-server thread. When a cold Codex session already has a cross-harness handoff, Relay starts the thread and injects that handoff on the same app-server connection before closing it, making the session safely resumable.

A cold OpenCode task with no handoff attaches without a session so OpenCode owns its normal welcome screen and creates the session on first native activity. Warm tasks resume their binding, while a cold destination with cross-harness context creates and seeds a resumable session before attachment.

## The synchronization sequence

Before opening a bound destination, Relay:

1. reads a snapshot of completed native turns and explicit native visibility state;
2. reads canonical messages after the persisted destination `lastSyncedSeq`;
3. removes messages already represented in a newly selected native transcript;
4. injects the remaining delta without asking a model to respond;
5. advances the synchronization cursor only after injection succeeds;
6. imports newly discovered native turns, reconciles OpenCode undo/redo visibility, and launches the native frontend.

Computing the delta before importing out-of-band native turns is intentional. Importing first could advance the destination cursor past cross-harness messages that still need delivery.

After the frontend exits, Relay resolves the session that was actually active and synchronizes it. Headless turns are linked to their native turn IDs on first attachment rather than duplicated. OpenCode turns hidden by native undo remain in the append-only log with a visibility tombstone, so redo can restore them without reusing or renumbering message sequences.

If native `/new`, `/resume`, or session navigation moves to another materialized session, Relay treats that native action as an intentional context reset. It rebinds the current task and imports completed turns, but does not retroactively append the prior task log behind them. Future completed turns remain part of the canonical task and can cross to the other harness normally. A selection that produces no trustworthy server-visible activity can be impossible to distinguish from the prior session; Relay keeps the previous binding rather than guessing.

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
  index.json                 # versioned task index
  processes/                 # secret-free child ownership records
  deletions/                 # crash-recovery journals, normally empty
  threads/
    <relay-task-id>/
      thread.json
      events.jsonl
      native-visibility.json  # created when native IDs or undo state need linking
```

Relay creates directories with mode `0700` and files with mode `0600` on Unix-like systems. Index and task metadata carry an explicit storage version; current unversioned files migrate atomically on first safe access, while files from an unknown future format are never rewritten. Message storage is append-oriented and recoverable through small pending-turn and pending-handoff journals. Handoff reads retain at most the bounded context window described above. OpenCode native recovery uses cursor pages and keeps only visible conversation text. Task recovery and explicit history inspection may read the selected task's complete canonical log.

Set `RELAY_DATA_DIR` to use another location.

Exit Relay before deleting that directory to erase Relay's local records. Vendor-native sessions and workspace files are separate and are not deleted with it.

## Failure behavior

- A task-wide run lease prevents a second Relay TUI, headless turn, or native control from using the same task concurrently. A second canonical checkout lease prevents different Relay tasks from running agents in the same git worktree. Short state locks still protect metadata transitions inside the owning TUI.
- Every detached Relay-owned child has a private, secret-free ownership record. After SIGKILL, the next Relay launch compares both owner and child OS start identities before terminating an orphaned process group; an identity mismatch is discarded without signaling the live process.
- Before changing a vendor session, Relay journals the handoff and clears that journal in the same metadata update that advances the cursor. If Relay stops in between, the next launch retires the uncertain binding and performs one clean bounded handoff into a fresh session. The abandoned vendor session may remain in that harness's history, but Relay will not append the batch to it again.
- A definitively deleted vendor session is replaced once with a cold session and the bounded canonical handoff. Transient, authentication, and generic protocol failures do not discard bindings.
- A task cannot run from a different working directory without explicit selection or creation there.
- Binding and synchronization cursors advance only after confirmed operations.
- A failed native turn may still have edited files; Relay does not pretend the workspace rolled back.
- Abrupt machine or process termination can leave a vendor session or workspace ahead of canonical history. Relay imports completed native turns on the next attachment when the upstream API exposes them.
- Relay never silently approves a native request. The real TUI remains the interactive client.

## Why cross-pairing is not a skin setting

OpenCode’s TUI speaks OpenCode’s HTTP/SSE protocol and assumes OpenCode session, message, tool, permission, and command schemas. Codex’s TUI speaks the Codex app-server protocol and assumes Codex thread, turn, item, approval, and configuration schemas.

Making the literal OpenCode binary control Codex would require a stateful protocol adapter implementing the full server expected by OpenCode while translating every operation and stream to Codex, and the reverse for a Codex TUI over OpenCode. A visual theme cannot do that.

Relay’s first release therefore guarantees native matched pairs and a common switch/context layer. Cross-pairing can be added only when the protocol translation is complete enough to preserve commands, approvals, tools, cancellation, recovery, and streaming—not merely the home screen.
