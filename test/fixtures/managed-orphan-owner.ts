#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { trackManagedProcess } from "../../src/services/process-registry.ts";

const ready = process.env.RELAY_TEST_READY;
const marker = process.env.RELAY_TEST_MARKER;
const dataRoot = process.env.RELAY_TEST_DATA_ROOT;
if (!ready || !marker || !dataRoot) {
  throw new Error("RELAY_TEST_READY, RELAY_TEST_MARKER, and RELAY_TEST_DATA_ROOT are required");
}

const child = Bun.spawn(
  [process.execPath, new URL("managed-orphan-child.ts", import.meta.url).pathname],
  {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...Bun.env, RELAY_TEST_MARKER: marker },
    detached: true,
  },
);
await trackManagedProcess(dataRoot, child, "sigkill-test-child");
await writeFile(ready, `${JSON.stringify({ childPid: child.pid })}\n`);
setInterval(() => undefined, 1_000);
