#!/usr/bin/env bun

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write(`\u001b[2J\u001b[HFAKE_NATIVE_READY:${process.env.TERM}`);
process.stdin.on("data", (chunk) => {
  process.stdout.write(`INPUT:${Buffer.from(chunk).toString("hex")}`);
});

process.on("SIGTERM", () => {
  process.stdout.write(":TRAILING_OUTPUT");
  process.exit(0);
});
