# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose credentials, transcript data, or unintended command execution. Report it through [GitHub's private vulnerability reporting](https://github.com/AksharP5/relay/security/advisories/new).

Include the Relay version, operating system, affected harness, reproduction steps, and expected impact. Do not include live credentials or private transcripts.

## Security model

Relay invokes locally installed Codex and OpenCode CLIs with the user's existing configuration. It does not handle provider credentials itself. The selected harness remains responsible for tool permissions, sandboxing, approvals, and network requests.

Relay stores canonical conversation text, task titles and IDs, absolute working directories, active-harness state, native session identifiers, synchronization cursors, and timestamps locally. Relay creates these directories and files for the current user only on Unix-like systems, but it does not encrypt data at rest. Anyone who gains access as that user may be able to read it.

Relay sends prompts to both harness CLIs over stdin and retains only bounded process diagnostics in memory. The harnesses can still write their own native histories according to their own configuration.

While a native workspace is open, Relay owns a temporary loopback-only backend. Codex uses an ephemeral capability token stored in a private temporary file and passed to the TUI by environment-variable name. OpenCode uses an ephemeral Basic-auth password passed through the environment. Relay does not place either secret in child-process arguments, write it to task metadata, or keep the backend alive after leaving that harness.

Relay's canonical log intentionally contains completed visible user and assistant text so another harness can receive it. It does not contain hidden reasoning, raw terminal output, tool payloads, or copied credential files.

Only the latest release on the default branch receives security fixes during the early release period.
