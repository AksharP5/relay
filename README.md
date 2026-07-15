# Relay

Use the real Codex and OpenCode TUIs on one continuous coding task.

https://github.com/user-attachments/assets/66e6697b-ea59-47c9-898e-a50353af2910

```console
$ cd my-project
$ relay
```

Or launch the workspace directly from another directory with `relay ./my-project`.

Relay opens the selected harness exactly as its own CLI renders it. Codex looks and behaves like Codex; OpenCode looks and behaves like OpenCode. Type `/` and the native command palette owns the input. `Escape` remains owned by that native TUI, including any version-specific behavior.

> **Platform support:** Relay supports macOS 13 or newer and glibc 2.25+ Linux. Native Windows and WSL are outside the current support and test scope.

To switch harnesses while the current session is idle, press `Ctrl+Q` by default. Relay carries the completed conversation forward and opens the other real TUI. The binding is fully customizable, and `F6` remains available as a fallback (`Fn+F6` when macOS treats the function row as media keys). See [Terminal shortcuts](#terminal-shortcuts).

## Why use Relay?

Codex and OpenCode have different models, tools, permission systems, commands, and strengths. Moving between them normally means starting over or manually writing a handoff.

Relay makes that transition part of the terminal workflow:

- **Keep the native experience.** Relay does not redraw, imitate, or embed screenshots of either interface. It hosts the installed CLI in a real pseudo-terminal.
- **Keep one task.** Completed user and assistant messages are carried to the other harness, while the shared working directory carries the code and tool results.
- **Keep native commands.** `/resume`, `/model`, `/undo`, `/sessions`, approval prompts, keyboard shortcuts, and dialogs are handled by the selected application.
- **Resume both sides.** Relay remembers the Codex thread and OpenCode session associated with the task.
- **Move only the delta.** A harness receives conversation it has not already seen instead of a rebuilt prompt on every turn.
- **Stay lightweight.** Only the selected TUI and its local backend are alive. Relay does not keep two renderers, a terminal framebuffer, an indexer, or a daemon in memory.
- **Keep credentials where they belong.** Authentication, provider settings, MCP servers, agents, tools, and permissions remain owned by Codex and OpenCode.

## What “native” means

Relay is a transparent terminal layer around the upstream applications:

```text
your terminal
    └── Relay PTY host
          ├── native Codex TUI ── Relay-owned Codex app-server
          └── native OpenCode TUI ── Relay-owned OpenCode server
```

Only one branch runs at a time. Relay forwards terminal bytes unchanged, including colors, alternate-screen behavior, mouse input, enhanced keyboard sequences, bracketed paste, and resize events. It reserves the configured switch binding and `F6` for direct switching.

The current release pairs each interface with its own engine: Codex TUI with Codex, and OpenCode TUI with OpenCode. Running the literal OpenCode TUI against the Codex engine would require a complete, bidirectional translation between their live protocols, approvals, tools, streaming events, session semantics, and commands. Relay does not claim that adapter exists yet.

There is no separate skin setting in this release: switching harnesses also switches to that harness's native interface. A Codex engine with the OpenCode interface—or the reverse—is the cross-pairing protocol work described above, not a theme toggle.

## How context moves

A Relay task stores a small canonical log and a binding for each harness.

1. Relay reads the destination’s completed native transcript.
2. It compares the persisted synchronization cursor with the canonical log.
3. It injects only missing messages, then advances the cursor after confirmation.
4. It imports newly discovered native turns and starts the destination’s real TUI.

OpenCode receives a synthetic, hidden `noReply` message. Codex receives structured app-server context items. Neither handoff causes an inference request. After the handoff, the native session resumes normally, preserving the stable prefix that provider prompt caches prefer.

The handoff is shared model context, not a rewrite of vendor-owned chat storage. A relayed turn can therefore be known by the destination model without appearing as a normal message in that native TUI's timeline. `relay history` is the complete visible Relay transcript; native timelines show messages created by that native harness. Relay does not edit private session databases to make them look identical.

Relay transfers visible conversation—not hidden reasoning, raw tool payloads, approval state, provider cache entries, or another harness’s private database. The receiving harness should inspect the shared workspace because it is the source of truth for file changes.

Handoffs are bounded to the newest 200 messages and 120,000 characters. This keeps memory and context usage predictable without paying for an automatic summarization call. Native context-window errors and native compaction remain visible and controllable in the selected TUI.

Read [How Relay keeps context](docs/how-relay-works.md) for lifecycle details and edge cases.

## Install

### Supported platforms

- macOS 13 or newer on Apple Silicon or Intel
- glibc 2.25 or newer Linux on arm64 or x64

Native Windows and WSL are intentionally deferred for now. Relay's terminal host currently depends on Unix pseudo-terminal and process semantics; native Windows support requires a dedicated ConPTY backend rather than another npm binary. Although a glibc-based WSL distribution resembles a supported Linux environment, Relay does not currently claim or test WSL compatibility.

### Runtime prerequisites

- the latest stable [Codex CLI](https://github.com/openai/codex)
- the latest stable [OpenCode](https://opencode.ai/)
- authentication completed in each harness you plan to use

One npm-based way to install or update both harnesses is:

```bash
npm install --global @openai/codex@latest opencode-ai@latest
```

### Install Relay

```bash
npm install --global @akshar5/relay@latest
relay doctor
```

That one command installs a ready-to-run native executable for the current machine. Relay supports Apple Silicon and Intel macOS 13+, plus x64 and arm64 glibc 2.25+ Linux. npm selects only the matching platform package; it does not download the other executables. Bun is not required at runtime, and the tiny launcher replaces itself with Relay instead of leaving an extra process in memory.

Update with the same command:

```bash
npm install --global @akshar5/relay@latest
```

### Build from source

Source installation additionally requires [Bun](https://bun.sh/) 1.3 or newer.

```bash
git clone https://github.com/AksharP5/relay.git
cd relay
bun install
bun run check
bun run build
bun link
relay doctor
```

The build creates a standalone Relay executable for the current platform. Re-run `bun run build` after pulling changes. Source builds are for contributors; npm is the supported installation channel.

Relay targets the latest stable releases rather than silently pinning old harnesses. The current automated contract passes with Codex CLI `0.144.3` and OpenCode `1.17.20`. On every relevant `main` change and once per day, compatibility CI installs both `@latest` packages on Linux and macOS and exercises their schemas, authenticated local servers, event streams, session creation, hidden handoff injection, resume, deleted-session recovery, status, and cleanup without a model call. The PTY byte path also has automated terminal tests.

Relay does not auto-update tools on startup. That would add latency, network traffic, and an unexpected global machine mutation. `relay doctor` reports the locally installed versions; Relay’s CI detects upstream changes, and releases should pass `bun run compat:latest` against the latest harnesses.

## Use the native workspace

Run Relay from the directory you want the agents to edit, or pass that directory explicitly:

```bash
relay
relay .
relay ../another-project
relay /absolute/path/to/project
```

All four forms select the same directory-bound workspace behavior. Relative paths resolve from the current shell directory. Relay uses the most recent task bound to the selected directory or creates a new local task. It opens that task’s active harness—Codex by default for a new task.

| Input                                    | Owner      | Action                                         |
| ---------------------------------------- | ---------- | ---------------------------------------------- |
| `/`, letters, `Enter`                    | Native TUI | Type and run native slash commands normally    |
| `Escape`                                 | Native TUI | Handle according to that TUI's native behavior |
| `Ctrl+C`                                 | Native TUI | Interrupt or exit according to native behavior |
| Configured key (`Ctrl+Q` by default)     | Relay      | Switch directly to the other harness when idle |
| `F6` (`Fn+F6` with macOS media-key mode) | Relay      | Fixed fallback switch key                      |

Relay refuses to detach while a turn is active. The terminal bell sounds and the current TUI stays visible until its response, tool call, retry, approval, or question reaches a safe idle state. Wait for it to finish, then use the switch key again. The completed turn is imported before the other harness opens.

This is a current safety boundary, not a claim that background switching is impossible. A safe background mode would temporarily keep the source runtime alive, preserve its approvals and output, open the destination, and hold destination model requests until the source turn finishes and crosses over. Otherwise two agents could branch from different conversation states while editing the same worktree. Relay's first release keeps one harness stack alive at a time, so partial output remains in its source TUI and never appears live inside the other native interface.

Relay cannot safely add `/harness` to both stock native command palettes today. OpenCode exposes a local TUI command plugin API, but Codex does not expose a corresponding host-command extension point. Relay could intercept raw text only by guessing whether bytes belong to a composer, dialog, Vim state, search field, history edit, or external editor. That would compromise the native behavior Relay exists to preserve, so every slash command remains native.

### Terminal shortcuts

Relay uses OpenCode-style key names and does not restrict the primary binding to a curated list. Change it with:

```bash
relay config
relay config set switch-key ctrl+g
relay config set switch-key shift+return
relay config set switch-key super+k
relay config reset switch-key
```

Bindings are case-insensitive single key chords. Combine any of `ctrl`, `alt`/`option`, `shift`, `super`/`cmd`, `hyper`, or `meta` with a printable Unicode key or a named key such as `return`, `escape`, `space`, `left`, `pageup`, `f1` through `f35`, keypad keys, or media keys. `KeyCode:<number>` covers any additional CSI-u/Kitty key code a terminal reports. Set the binding to `none` to disable the primary shortcut. Changes apply the next time bare `relay` launches.

Relay accepts unusual bindings instead of rejecting them. A plain character or editing key is consumed by Relay while a native TUI is open. Modifier combinations such as `super+k`, some media keys, and raw key codes require a terminal that reports those keys through CSI-u/Kitty keyboard events. Your terminal emulator or multiplexer can still capture a shortcut before Relay receives it.

`Ctrl+Q` works without configuration in a direct WezTerm session and in tmux. Relay runs its PTY in raw mode, so it receives the control byte instead of treating it as terminal flow control. Codex and OpenCode do not assign `Ctrl+Q` in their current default keymaps.

Zellij's default keymap reserves `Ctrl+Q` for quitting. Choose another Relay binding or use `F6` inside Zellij. Relay intentionally keeps `F6` as the recovery shortcut regardless of the configured primary binding.

### Bring an existing session into Relay

Existing sessions remain in their native harness. To adopt one, run Relay from the same workspace, open Codex's `/resume` or OpenCode's `/sessions`, and select it normally. Once that session is idle, use the configured switch binding or `F6` to import its completed visible turns and open the other harness with that context. On a cold launch, wait two seconds after the selection `Enter`; on a warm session, Relay conservatively treats a recent `Enter` as a model request until it observes a completed native turn. If a non-model command leaves the session unchanged and the switch rings the bell, wait briefly and retry. OpenCode can then be adopted without sending it a new prompt because Relay reads the exact native continuation ID from its graceful exit rather than guessing from screen content.

The other harness binding is lazy. If it does not exist yet, Relay creates and seeds it only when you first switch there. Returning later resumes the same two native bindings.

Selecting an existing session is an intentional context reset for the current Relay task: Relay adopts that session's completed conversation and does not append an unrelated older task transcript behind it. Only sessions from the current workspace can be adopted. Relay supports sessions exposed by the native picker; it does not add a second history browser for session kinds that Codex or OpenCode omit from their own UI.

## Headless commands

The native TUI is the primary interface. Relay also keeps a headless surface for scripts and diagnostics:

```bash
relay doctor
relay config
relay config set switch-key ctrl+g
relay new "Improve the parser" --with codex
relay ask "Find the edge case and add a focused test"
relay ask --with opencode "Review the implementation"
relay use codex
relay status
relay history
relay list
relay thread <id>
relay export [id] [--out relay-task.json]
relay delete [id] --force
```

See the [command guide](docs/commands.md) for full examples.

## Storage and performance

Relay stores its versioned `config.json`, canonical visible message text, and task metadata under `~/.local/share/relay` by default. Metadata includes the task ID, directory, active harness, active-context boundary, native session IDs, synchronization cursors, native undo visibility, and timestamps.

It does not copy credential files, vendor session databases, raw terminal output, or tool traces. Canonical messages use append-only JSON Lines within the active conversation. When you adopt a different native conversation, Relay compacts the superseded canonical prefix; the vendor's own session remains the source of truth if you select it again. Switch handoffs scan only the active log with a bounded message and character window; OpenCode recovery reads vendor history in cursor pages and immediately discards non-visible tool payloads. Submission safety checks do not reread full conversations: Codex returns at most five turn summaries and OpenCode returns at most 20 recent message records. While a TUI is active, Relay otherwise keeps only small routing queues, the handoff delta needed for a switch, and—for OpenCode only—an in-memory exit tail capped at 8 KiB so it can recognize the selected continuation ID. That tail is discarded when the native process exits and is never written to Relay storage.

Each active backend binds only to loopback and uses an ephemeral capability secret:

- Codex: authenticated WebSocket app-server; the token lives in a private temporary file and environment variable.
- OpenCode: password-protected HTTP server; the password lives in memory/environment and never appears in process arguments.

Both the backend and native frontend stop when Relay leaves that harness. Native session persistence remains in the harness’s own storage.

Set `RELAY_DATA_DIR` to place Relay’s canonical log elsewhere. Protect it like any local agent transcript.

Use `relay export` for a user-readable JSON archive of visible task messages. It intentionally excludes internal native session IDs, locks, journals, hidden undo entries, secrets, and vendor databases. It is an archive, not an importable backup.

Use `relay delete [id] --force` to erase one task's Relay-owned records. Deletion is journaled so an interrupted delete finishes on the next launch. It does not delete files in the workspace or sessions retained by Codex and OpenCode.

## Current boundaries

- Relay supports Codex and OpenCode on macOS 13+ and glibc 2.25+ Linux. Native Windows and WSL are intentionally outside the current support and automated-test matrix; native Windows PTY hosting is not implemented.
- Relay prevents two tasks from running agents in the same git checkout, including tasks started from nested or symlinked paths. Use separate git worktrees for intentional concurrency.
- Cross-engine continuity includes completed visible text and the working tree, not hidden state.
- A turn must finish in its source TUI before Relay switches; partial streaming output is not mirrored into the destination TUI.
- Attachments and rich tool events stay in their native session; they are not translated into the other harness.
- Native undo, compaction, sharing, and session commands still use native semantics. Relay reconciles explicit OpenCode undo/redo visibility for completed imported turns, but it will not rewrite vendor-owned storage to force two histories to become identical.
- If a harness edits files and then fails, the workspace may be ahead of the canonical conversation. Inspect `git status` before retrying.
- Literal cross-pairing—such as OpenCode’s TUI over Codex—is future protocol-adapter work, not a cosmetic skin toggle.

These boundaries favor native fidelity, supported interfaces, and recoverable local state over fragile emulation.

## Development

Relay is TypeScript on Bun, with [Effect](https://effect.website/) services around storage and harness operations. Native rendering is intentionally left to Codex and OpenCode; Relay’s terminal layer uses Bun’s PTY primitives.

```bash
bun install
bun run check
bun run compat:latest
bun run build
```

The implementation style is informed by [Effect Solutions](https://github.com/kitlangton/effect-solutions), [OpenCode](https://github.com/anomalyco/opencode), and [Executor](https://github.com/UsefulSoftwareCo/executor). Relay is not affiliated with OpenAI or the OpenCode project.

Release demos and native TUI checks can use [Terminal Control](https://github.com/anomalyco/terminal-control). It records general PTY applications, including Codex; OpenCode additionally needs its `--host opentui` handshake. Relay does not depend on it at runtime. Raw `.termctrl` timelines include terminal output and typed input, so keep them local and share only reviewed exports such as scrubbed MP4s.

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Akshar Patel
