#!/usr/bin/env bun

const trace = Bun.env.RELAY_TEST_TRACE;
if (!trace) throw new Error("RELAY_TEST_TRACE is required");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli test\n");
  process.exit(0);
}

const prompt = await Bun.stdin.text();
await Bun.write(
  Bun.file(trace),
  `${await Bun.file(trace)
    .text()
    .catch(() => "")}${JSON.stringify({
    harness: "codex",
    args: process.argv.slice(2),
    prompt,
  })}\n`,
);

process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-native" })}\n`);
process.stdout.write(
  `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Codex completed" },
  })}\n`,
);
