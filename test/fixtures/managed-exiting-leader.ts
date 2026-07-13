#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";

const ready = process.env.RELAY_TEST_READY;
if (!ready) throw new Error("RELAY_TEST_READY is required");

const descendant = Bun.spawn(["/bin/sleep", "30"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
await writeFile(ready, `${JSON.stringify({ descendantPid: descendant.pid })}\n`);
await Bun.sleep(250);
process.exit(0);
