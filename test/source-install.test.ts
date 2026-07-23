import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Bun source install", () => {
  it("links the built Relay executable into an isolated Bun prefix", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "relay-source-install-"));
    temporaryDirectories.push(prefix);

    await execFileAsync("bun", ["run", "build"], { cwd: projectRoot });
    await execFileAsync("bun", ["link"], {
      cwd: projectRoot,
      env: { ...process.env, BUN_INSTALL: prefix },
    });

    const [{ stdout: linkedVersion }, { stdout: builtVersion }] = await Promise.all([
      execFileAsync(join(prefix, "bin", "relay"), ["--version"]),
      execFileAsync(join(projectRoot, "dist", "relay"), ["--version"]),
    ]);

    expect(linkedVersion.trim()).toBe(builtVersion.trim());
  }, 30_000);
});
