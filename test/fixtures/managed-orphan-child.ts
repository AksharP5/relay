#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";

const marker = process.env.RELAY_TEST_MARKER;
if (!marker) throw new Error("RELAY_TEST_MARKER is required");

process.on("SIGTERM", () => undefined);
setTimeout(() => void writeFile(marker, "orphan survived\n"), 1_800);
setInterval(() => undefined, 1_000);
