# Contributing to Relay

Thanks for helping make cross-harness work less awkward.

## Before opening a change

Open an issue for a new harness, storage-format change, or user-visible behavior change so the compatibility and privacy tradeoffs can be discussed first. Small fixes and documentation improvements can go straight to a pull request.

Relay's design priorities are:

1. preserve the literal upstream TUI experience;
2. preserve a clear canonical conversation;
3. use supported harness interfaces instead of private database writes;
4. keep storage and runtime overhead small;
5. make failures explicit and recoverable;
6. explain limitations honestly.

## Local setup

```bash
git clone https://github.com/AksharP5/relay.git
cd relay
bun install
bun run check
```

Use `RELAY_DATA_DIR` for development and manual tests so they do not affect your normal tasks:

```bash
RELAY_DATA_DIR=/tmp/relay-dev bun run relay -- new "Adapter test"
```

## Tests

`bun run check` runs formatting, TypeScript, and the automated test suite. Adapter parsing should have fixture-level tests. Changes to a live adapter should also be tested against the corresponding installed CLI, but live model calls must not be part of CI.

`bun run compat:latest` installs nothing and tests the currently resolved Codex and OpenCode executables through real local servers without a model call. The scheduled GitHub workflow first installs both latest stable packages, records their resolved versions, and runs this contract on Linux daily; manual runs also cover macOS.

Changes to PTY input, process lifetime, session preparation, hidden injection, active-session resolution, or transcript import must include a focused regression for the failure they could cause. Do not add broad tests that merely repeat type checking or implementation details.

Never add credentials, provider responses containing private data, or real user transcripts as fixtures.

## Code style

- Keep Effect service boundaries around capabilities that need alternate test implementations.
- Use tagged errors for expected operational failures.
- Prefer small modules with explicit inputs over global state.
- Keep the canonical format independent from any one harness.
- Keep native frontend bytes and native slash-command input out of Relay-owned renderers.
- Add dependencies only when they materially simplify the product.

By contributing, you agree that your contribution is licensed under the MIT License.
