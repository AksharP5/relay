# Relay

Use the real Codex and OpenCode TUIs on one continuous coding task.

```console
$ cd my-project
$ relay
```

Relay opens the selected harness exactly as its own CLI renders it. Codex looks and behaves like Codex; OpenCode looks and behaves like OpenCode. Type `/` and the native command palette owns the input. Press `Escape` and the native dialog closes normally.

To switch harnesses, press `Ctrl+]`, release it, then press `R`. Relay briefly shows a two-item selector, carries the completed conversation forward, and opens the other real TUI.

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

Only one branch runs at a time. Relay forwards terminal bytes unchanged, including colors, alternate-screen behavior, mouse input, enhanced keyboard sequences, bracketed paste, and resize events. It reserves one prefix chord—`Ctrl+]`, then `R`—so ordinary native keys remain available.

The current release pairs each interface with its own engine: Codex TUI with Codex, and OpenCode TUI with OpenCode. Running the literal OpenCode TUI against the Codex engine would require a complete, bidirectional translation between their live protocols, approvals, tools, streaming events, session semantics, and commands. Relay does not claim that adapter exists yet.

## How context moves

A Relay task stores a small canonical log and a binding for each harness.

1. Relay reads the destination’s completed native transcript.
2. It compares the persisted synchronization cursor with the canonical log.
3. It injects only missing messages, then advances the cursor after confirmation.
4. It imports newly discovered native turns and starts the destination’s real TUI.

OpenCode receives a synthetic, hidden `noReply` message. Codex receives structured app-server history items. Neither handoff causes an inference request. After the handoff, the native session resumes normally, preserving the stable prefix that provider prompt caches prefer.

Relay transfers visible conversation—not hidden reasoning, raw tool payloads, approval state, provider cache entries, or another harness’s private database. The receiving harness should inspect the shared workspace because it is the source of truth for file changes.

Handoffs are bounded to the newest 200 messages and 120,000 characters. This keeps memory and context usage predictable without paying for an automatic summarization call. Native context-window errors and native compaction remain visible and controllable in the selected TUI.

Read [How Relay keeps context](docs/how-relay-works.md) for lifecycle details and edge cases.

## Install

### Prerequisites

- [Bun](https://bun.sh/) 1.3 or newer
- the latest stable [Codex CLI](https://github.com/openai/codex)
- the latest stable [OpenCode](https://opencode.ai/)
- authentication completed in each harness you plan to use

One npm-based way to install or update both harnesses is:

```bash
npm install --global @openai/codex@latest opencode-ai@latest
```

Install Relay from source:

```bash
git clone https://github.com/AksharP5/relay.git
cd relay
bun install
bun run check
bun run build
bun link
relay doctor
```

The build creates a standalone Relay executable for the current platform. Re-run `bun run build` after pulling changes.

Relay targets the latest stable releases rather than silently pinning old harnesses. The current automated contract passes with Codex CLI `0.144.3` and OpenCode `1.17.18`. On every relevant `main` change and once per day, compatibility CI installs both `@latest` packages on Linux and macOS and exercises their schemas, authenticated local servers, event streams, session creation, hidden handoff injection, resume, deleted-session recovery, status, and cleanup without a model call. The PTY byte path also has automated terminal tests; release candidates are smoke-tested with the real installed TUIs.

Relay does not auto-update tools on startup. That would add latency, network traffic, and an unexpected global machine mutation. `relay doctor` reports the locally installed versions; Relay’s CI detects upstream changes, and releases should pass `bun run compat:latest` against the latest harnesses.

## Use the native workspace

Run Relay from the directory you want the agents to edit:

```bash
relay
```

Relay uses the most recent task bound to that directory or creates a new local task. It opens that task’s active harness—Codex by default for a new task.

| Input                 | Owner          | Action                                                    |
| --------------------- | -------------- | --------------------------------------------------------- |
| `/`, letters, `Enter` | Native TUI     | Type and run native slash commands normally               |
| `Escape`              | Native TUI     | Close its active dialog or autocomplete                   |
| `Ctrl+C`              | Native TUI     | Interrupt or exit according to native behavior            |
| `Ctrl+]`, then `R`    | Relay          | Open the harness selector when the native session is idle |
| `↑` / `↓`, `Enter`    | Relay selector | Choose Codex or OpenCode                                  |
| `Escape`              | Relay selector | Return to the current harness                             |
| `q`                   | Relay selector | Exit Relay                                                |

Relay refuses to detach while a turn is active, because doing so could strand an approval or lose streaming state. The terminal bell sounds; wait for the turn to finish, then use the switch chord again.

Native session navigation remains native. Relay detects a Codex thread created or resumed inside the Codex TUI, and an OpenCode session that becomes active through native work, then updates the task binding and imports its completed turns. Merely highlighting a different OpenCode session and switching away before any activity may not produce a server event; in that narrow case Relay can reopen the prior binding.

## Headless commands

The native TUI is the primary interface. Relay also keeps a headless surface for scripts and diagnostics:

```bash
relay doctor
relay new "Improve the parser" --with codex
relay ask "Find the edge case and add a focused test"
relay ask --with opencode "Review the implementation"
relay use codex
relay status
relay history
relay list
relay thread <id>
```

See the [command guide](docs/commands.md) for full examples.

## Storage and performance

Relay stores canonical visible message text and task metadata under `~/.local/share/relay` by default. Metadata includes the task ID, directory, active harness, native session IDs, synchronization cursors, native undo visibility, and timestamps.

It does not copy credential files, vendor session databases, raw terminal output, or tool traces. Canonical messages use append-only JSON Lines and are streamed from disk with bounded windows. While a TUI is active, Relay keeps only small routing queues and the handoff delta needed for a switch.

Each active backend binds only to loopback and uses an ephemeral capability secret:

- Codex: authenticated WebSocket app-server; the token lives in a private temporary file and environment variable.
- OpenCode: password-protected HTTP server; the password lives in memory/environment and never appears in process arguments.

Both the backend and native frontend stop when Relay leaves that harness. Native session persistence remains in the harness’s own storage.

Set `RELAY_DATA_DIR` to place Relay’s canonical log elsewhere. Protect it like any local agent transcript.

## Current boundaries

- Relay currently supports Codex and OpenCode on macOS and Linux. Windows PTY hosting is not implemented.
- Cross-engine continuity includes completed visible text and the working tree, not hidden state.
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

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Akshar Patel
