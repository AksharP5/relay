#!/usr/bin/env bun

const trace = Bun.env.RELAY_TEST_TRACE;
if (!trace) throw new Error("RELAY_TEST_TRACE is required");
if (process.argv.includes("--version")) {
  process.stdout.write("opencode test\n");
  process.exit(0);
}

const prompt = await Bun.stdin.text();
await Bun.write(
  Bun.file(trace),
  `${await Bun.file(trace)
    .text()
    .catch(() => "")}${JSON.stringify({
    harness: "opencode",
    args: process.argv.slice(2),
    prompt,
  })}\n`,
);

process.stdout.write(`${JSON.stringify({ type: "step_start", sessionID: "opencode-native" })}\n`);
process.stdout.write(
  `${JSON.stringify({
    type: "text",
    sessionID: "opencode-native",
    part: { text: "OpenCode completed" },
  })}\n`,
);
