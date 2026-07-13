# Relay

Carry one coding task between Codex and OpenCode.

Relay is a terminal workspace where Codex and OpenCode can take turns on the same task. The transcript, composer, and working directory stay put; the underlying harness and interface skin can be changed independently at any time.

```console
$ cd my-project
$ relay
```

Write the first request, press `Enter`, and Relay starts the task with Codex. Press `Ctrl+R` to choose the underlying harness and `Ctrl+T` to choose the Codex or OpenCode interface. Switching either one does not close the interface or clear the draft.

## Why Relay?

Coding harnesses have different strengths. One may have the model, tools, interface, or permission model you want for a particular turn. Today, changing harnesses usually means copying a transcript, writing a handoff prompt, or starting over.

Relay makes the handoff a normal part of the task:

- **Use the right harness per turn.** Choose Codex or OpenCode beside the composer without leaving the task.
- **Keep native sessions.** Relay resumes the same Codex and OpenCode sessions on later turns.
- **Keep one understandable workspace.** The canonical transcript stays visible while each response is labeled by the harness that produced it.
- **Switch without rebuilding everything.** A harness receives only the conversation it has not seen yet, then resumes normally on later turns.
- **Stay lightweight.** No daemon, background indexer, shadow transcript, or copy of a vendor session database.
- **Keep your existing setup.** Authentication, models, tools, and agents remain owned by Codex and OpenCode. Relay does not copy credentials or provider configuration.
- **Choose the interface independently.** Use the OpenCode-compatible interface over Codex, the Codex-compatible interface over OpenCode, or link the interface so it switches with the harness.
- **Keep familiar commands.** `/sessions` and `/resume` open the same Relay task picker; portable commands are translated, while truly native-only commands stay visible but disabled with an explanation.

## How it works

A Relay task is a small canonical conversation plus a binding to each native harness session.

1. The first turn in a harness creates a native session for that harness.
2. Later turns in the same harness resume that session directly.
3. When you switch, Relay sends only the conversation added since that harness last ran.
4. The harness still inspects and edits the shared working directory as usual.

Relay stores message text plus small task metadata under `~/.local/share/relay`. Metadata includes the task title and ID, working directory, active harness, native session IDs, synchronization cursors, and timestamps. It does **not** copy Codex or OpenCode session databases, store their credentials, or retain raw tool output. Partial streamed text exists only in the running interface; the completed response is the only copy Relay commits. Harness processes are short-lived: Relay launches them for capability discovery or an operation, then exits them instead of keeping both harnesses warm.

This provides practical continuity, not identical hidden state. A receiving harness gets the visible dialogue it missed and inspects the shared working tree. Hidden reasoning, private tool traces, provider caches, and harness-specific internals do not cross the boundary.

Read [How Relay keeps context](docs/how-relay-works.md) for the full model and its boundaries.

## Status

Relay is an early, working release for local Codex and OpenCode CLIs. The persistent TUI, create/switch/resume loop, and headless commands are tested on macOS. Linux should work anywhere Bun and the selected harness CLIs are available; Windows has not been tested yet.

Relay currently carries text conversation between harnesses and shows text events exposed by their supported JSON interfaces. It includes independent Codex/OpenCode skins, harness-specific models, semantic slash commands, native compaction/review/share controls, and guarded OpenCode undo/redo. Rich tool-call rendering, attachments, automatic import of turns made outside Relay, and additional harnesses are not in v0.1.

The compatibility skins are Relay interfaces, not embedded copies of the native TUIs. Normal turns use each harness's supported headless interface. Native commands that require an interactive approval or question Relay cannot render are reported as unsupported rather than silently approved. For full native interactive behavior, open the native session with `relay native`.

## Install

### Prerequisites

- [Bun](https://bun.sh/) 1.3 or newer
- [Codex CLI](https://github.com/openai/codex) and/or [OpenCode](https://opencode.ai/)
- Authentication completed in each harness you plan to use

Install from source:

```bash
git clone https://github.com/AksharP5/relay.git
cd relay
bun install
bun run build
bun link
relay doctor
```

The build produces a native Relay executable for your current platform, and `bun link` makes it available through Bun's global bin directory. Re-run `bun run build` after pulling Relay updates. If your shell cannot find it, add `${BUN_INSTALL:-$HOME/.bun}/bin` to `PATH`.

`relay doctor` reports whether both native CLIs can be found and shows their versions. Relay v0.1 has been live-tested with Codex CLI 0.144.1 and OpenCode 1.15.5; adapter changes in other versions may require an update.

## Use the TUI

From the project you want the agents to work on:

```bash
relay
```

The first submitted message creates a Relay task lazily, so opening and leaving an empty TUI writes no task or native session. The interface then stays open across every turn.

| Input                   | Action                                          |
| ----------------------- | ----------------------------------------------- |
| `Enter`                 | Send the draft through the selected harness     |
| `Shift+Enter`           | Add a newline                                   |
| `Ctrl+R`                | Open or close the Codex/OpenCode selector       |
| `Ctrl+T`                | Choose the Codex or OpenCode interface skin     |
| `Ctrl+O`                | Choose a model from the underlying harness      |
| `/`                     | Open commands for the selected interface        |
| `↑` / `↓`, then `Enter` | Choose a harness while the selector is open     |
| `Escape`                | Close the selector without changing the harness |
| `Ctrl+C`                | Exit Relay                                      |

The harness, skin, and model beside the composer are clickable in terminals with mouse support. Interface switching is linked to harness switching by default. Choosing a skin manually pins it; open the skin selector and press `Ctrl+L` to link or unlink automatic switching.

The selected skin supplies command names and defaults. Relay resolves those names to semantic actions before choosing an implementation:

- OpenCode `/sessions`, `/resume`, and Codex `/resume` all open Relay's task picker.
- `/model` or `/models` always lists models from the underlying harness, never from the skin.
- `/compact` uses the selected native implementation without adding a fake prompt to the transcript.
- OpenCode `/share` remains visible but disabled over Codex, with an explanation and the required harness.
- OpenCode `/undo` and `/redo` use OpenCode's file snapshot operations and move Relay's canonical transcript to the same turn.
- Project, skill, and MCP prompt commands discovered from OpenCode execute through OpenCode. Missed cross-harness context is injected before the command runs.

Use `/commands` to inspect a command's implementation and choose another verified implementation when more than one exists. Relay never offers an override that has no working adapter.

The workspace keeps its recent conversation window in memory for responsive rendering. The complete canonical transcript remains on disk and is available through `relay history`.

A task stays attached to the directory where it was created. Relay stops a turn with a directory-mismatch message rather than editing the wrong project. The headless commands can create, inspect, and select tasks when needed:

```bash
relay list
relay thread <id>
relay new "Improve the parser" --with codex
```

## Headless use

The TUI is the primary interface. The same engine also has commands for scripts, automation, diagnostics, and explicit model selection:

```bash
relay ask "Find the edge case and add a regression test"
relay ask --with opencode "Review the implementation for cases Codex missed"
relay ask --with codex --model <model-name> "Apply the useful findings"
```

Model names and availability belong to the selected harness and provider.
When a turn explicitly selects a model, Relay remembers it on that harness's native binding and reuses it on later turns until another model is selected.

## Commands

| Command                                               | Purpose                                       |
| ----------------------------------------------------- | --------------------------------------------- |
| `relay`                                               | Open the persistent conversation TUI          |
| `relay doctor`                                        | Check Codex and OpenCode availability         |
| `relay new [name] [--with harness]`                   | Start and select a Relay task                 |
| `relay ask [--with harness] [--model name] <message>` | Run the next turn                             |
| `relay use codex\|opencode`                           | Choose the harness for future turns           |
| `relay status`                                        | Show the current task and native bindings     |
| `relay history`                                       | Read the canonical cross-harness conversation |
| `relay list`                                          | List local Relay tasks                        |
| `relay thread <id>`                                   | Select another Relay task                     |
| `relay native [harness]`                              | Print the command that opens a native session |

See the [command guide](docs/commands.md) for examples and environment options.

## Prompt caching and performance

Relay is deliberately append-oriented. A resumed native session keeps its stable existing prefix, and a handoff adds only the missing dialogue. That shape is friendly to provider prompt caches, which generally require an exact repeated prefix.

Prompt caches are still provider- and model-specific: a cache created for Codex cannot be reused by OpenCode or another provider. Relay reduces avoidable context movement; it does not pretend caches are portable. For background, see [ngrok's prompt caching explanation](https://ngrok.com/blog/prompt-caching).

## Privacy and security

Relay runs locally and invokes CLIs already installed on your machine.

- It never reads or copies harness credential files.
- It adds no persistent daemon or telemetry. OpenCode discovery and native commands may use OpenCode's temporary password-protected loopback server, which is stopped after the operation.
- It stores canonical user/assistant text and the task metadata listed above in private local files.
- The selected harness keeps responsibility for sandboxing, approvals, tools, and provider traffic.

Relay itself adds no telemetry or persistent network service. The Codex and OpenCode processes it invokes can still contact their configured providers and services.

Conversation text can still contain sensitive information. Protect the Relay data directory as you would any local agent transcript. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

Relay is written in TypeScript with [Effect](https://effect.website/), Bun, Solid, and [OpenTUI](https://github.com/anomalyco/opentui). Effect services keep storage, process execution, and harness behavior independently testable; OpenTUI provides native terminal rendering and input without a browser or local web server.

```bash
bun install
bun run check
bun run build
```

The implementation style is informed by [Effect Solutions](https://github.com/kitlangton/effect-solutions), [OpenCode](https://github.com/anomalyco/opencode), and [Executor](https://github.com/UsefulSoftwareCo/executor). Relay is not affiliated with OpenAI or the OpenCode project.

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Akshar Patel
