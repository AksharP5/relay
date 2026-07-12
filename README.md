# Relay

Carry one coding task between Codex and OpenCode.

Relay gives each harness a turn without making you restart the conversation. Begin in Codex, ask OpenCode for a second pass, then return to the same Codex session with the new work in context.

```console
$ relay new "Fix the checkout flow" --with codex
$ relay ask "Find the cause and implement a fix"

$ relay ask --with opencode "Review that fix and run the focused tests"

$ relay ask --with codex "Address the review and finish the task"
```

## Why Relay?

Coding harnesses have different strengths. One may have the model, tools, interface, or permission model you want for a particular turn. Today, changing harnesses usually means copying a transcript, writing a handoff prompt, or starting over.

Relay makes the handoff a normal part of the task:

- **Use the right harness per turn.** Switch with `--with codex` or `--with opencode`.
- **Keep native sessions.** Relay resumes the same Codex and OpenCode sessions on later turns.
- **Keep one understandable history.** Relay records the user and assistant messages that cross the boundary.
- **Stay lightweight.** No daemon, background indexer, or duplicated vendor database.
- **Keep your existing setup.** Authentication, models, tools, agents, and permissions remain owned by Codex and OpenCode.

## How it works

A Relay task is a small canonical conversation plus a binding to each native harness session.

1. The first turn in a harness creates a native session for that harness.
2. Later turns in the same harness resume that session directly.
3. When you switch, Relay sends only the conversation added since that harness last ran.
4. The harness still inspects and edits the shared working directory as usual.

Relay stores message text plus small task metadata under `~/.local/share/relay`. Metadata includes the task title and ID, working directory, active harness, native session IDs, synchronization cursors, and timestamps. It does **not** copy Codex or OpenCode session databases, store their credentials, or retain raw tool output. Only the harness handling the current turn is launched.

Read [How Relay keeps context](docs/how-relay-works.md) for the full model and its boundaries.

## Status

Relay is an early, working release for local Codex and OpenCode CLIs. The core loop—create, switch, resume, and switch back—has live adapter coverage on macOS. Linux should work anywhere Bun and both harness CLIs are available; Windows has not been tested yet.

Relay currently carries text conversation between harnesses. Attachments, live streaming, automatic import of turns made outside Relay, and additional harnesses are not in v0.1.

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
bun link
relay doctor
```

`bun link` makes the `relay` command available through Bun's global bin directory. If your shell cannot find it, add `${BUN_INSTALL:-$HOME/.bun}/bin` to `PATH`.

`relay doctor` reports whether both native CLIs can be found and shows their versions. Relay v0.1 has been live-tested with Codex CLI 0.133.0 and OpenCode 1.15.5; adapter changes in other versions may require an update.

## Quick start

From the project you want the agents to work on:

```bash
relay new "Improve the parser" --with codex
relay ask "Find the edge case and add a regression test"
relay ask --with opencode "Review the implementation for cases Codex missed"
relay ask --with codex "Apply the useful review findings"
```

A Relay task stays attached to the directory where it was created. If another task is globally selected and you run `relay ask` from a different project, Relay stops with a directory-mismatch message instead of editing the old project. Use `relay list`, `relay thread <id>`, or `relay new` to select the right task.

You can also change the default harness without running a model:

```bash
relay use opencode
relay ask "Continue from here"
```

Relay forwards an explicit model when you provide one:

```bash
relay ask --with codex --model gpt-5.4 "Run one more review"
relay ask --with opencode --model openai/gpt-5 "Compare the alternatives"
```

Model names and availability belong to the selected harness and provider.

## Commands

| Command                                               | Purpose                                       |
| ----------------------------------------------------- | --------------------------------------------- |
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
- It does not add a network service or telemetry.
- It stores canonical user/assistant text and the task metadata listed above in private local files.
- The selected harness keeps responsibility for sandboxing, approvals, tools, and provider traffic.

Relay itself adds no telemetry or network service. The Codex and OpenCode processes it invokes can still contact their configured providers and services.

Conversation text can still contain sensitive information. Protect the Relay data directory as you would any local agent transcript. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

Relay is written in TypeScript with [Effect](https://effect.website/) and Bun. Effect services keep storage, process execution, and harness behavior independently testable while tagged errors keep expected failures explicit.

```bash
bun install
bun run check
bun run build
```

The implementation style is informed by [Effect Solutions](https://github.com/kitlangton/effect-solutions), [OpenCode](https://github.com/anomalyco/opencode), and [Executor](https://github.com/UsefulSoftwareCo/executor). Relay is not affiliated with OpenAI or the OpenCode project.

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Akshar Patel
