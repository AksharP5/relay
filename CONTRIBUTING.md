# Contributing to Relay

Thanks for helping make cross-harness work less awkward.

## Before opening a change

Open an issue for a new harness, storage-format change, or user-visible behavior change so the compatibility and privacy tradeoffs can be discussed first. Small fixes and documentation improvements can go straight to a pull request.

Relay's design priorities are:

1. preserve a clear canonical conversation;
2. use supported harness interfaces instead of private database writes;
3. keep storage and runtime overhead small;
4. make failures explicit and recoverable;
5. explain limitations honestly.

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

Never add credentials, provider responses containing private data, or real user transcripts as fixtures.

## Code style

- Keep Effect service boundaries around capabilities that need alternate test implementations.
- Use tagged errors for expected operational failures.
- Prefer small modules with explicit inputs over global state.
- Keep the canonical format independent from any one harness.
- Add dependencies only when they materially simplify the product.

By contributing, you agree that your contribution is licensed under the MIT License.
