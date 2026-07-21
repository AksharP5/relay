#!/usr/bin/env bun

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write(`\u001b[2J\u001b[HFAKE_NATIVE_READY:${process.env.TERM}`);
const outputBytes = Number(process.env.FAKE_NATIVE_OUTPUT_BYTES ?? 0);
let outputPending = Number.isFinite(outputBytes) && outputBytes > 0;
const writeConfiguredOutput = () => {
  if (!outputPending) return;
  outputPending = false;
  process.stdout.write(Buffer.alloc(outputBytes, "x"));
  process.stdout.write("FAKE_NATIVE_OUTPUT_READY");
};
if (process.env.FAKE_NATIVE_OUTPUT_ON_INPUT !== "1") writeConfiguredOutput();
process.stdin.on("data", (chunk) => {
  process.stdout.write(`INPUT:${Buffer.from(chunk).toString("hex")}`);
  writeConfiguredOutput();
});

process.on("SIGTERM", () => {
  process.stdout.write(process.env.FAKE_NATIVE_TRAILING_OUTPUT ?? ":TRAILING_OUTPUT");
  process.exit(0);
});
