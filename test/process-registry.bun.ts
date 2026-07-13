import { afterAll, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "relay-process-registry-"));
Bun.env.RELAY_DATA_DIR = directory;
const { cleanupOrphanedProcesses } = await import("../src/services/process-registry.ts");

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for process-registry fixture");
};

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  delete Bun.env.RELAY_DATA_DIR;
});

describe("managed process recovery", () => {
  it("kills a registered process group after its Relay owner is SIGKILLed", async () => {
    const ready = join(directory, "orphan-ready.json");
    const marker = join(directory, "orphan-marker.txt");
    const owner = Bun.spawn(
      [process.execPath, new URL("fixtures/managed-orphan-owner.ts", import.meta.url).pathname],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...Bun.env,
          RELAY_DATA_DIR: directory,
          RELAY_TEST_READY: ready,
          RELAY_TEST_MARKER: marker,
        },
        detached: true,
      },
    );
    await waitFor(async () => Bun.file(ready).exists());
    const { childPid } = JSON.parse(await readFile(ready, "utf8")) as { childPid: number };

    process.kill(owner.pid, "SIGKILL");
    await owner.exited;
    const result = await cleanupOrphanedProcesses();
    expect(result.terminated).toBe(1);
    await waitFor(async () => !processIsAlive(childPid));
    await Bun.sleep(1_850);
    await expect(access(marker)).rejects.toThrow();
    expect(
      (await readdir(join(directory, "processes"))).filter((name) => name.endsWith(".json")),
    ).toEqual([]);
  }, 8_000);

  it("does not signal a live process when its start identity does not match", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    const processes = join(directory, "processes");
    await mkdir(processes, { recursive: true, mode: 0o700 });
    await writeFile(
      join(processes, "reused.json"),
      `${JSON.stringify({
        version: 1,
        token: "reused",
        owner: { pid: 2_147_483_647, startedAt: "never" },
        child: { pid: child.pid, pgid: child.pid, startedAt: "different process" },
        kind: "identity-test",
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const result = await cleanupOrphanedProcesses();
    expect(result.discarded).toBe(1);
    expect(processIsAlive(child.pid)).toBe(true);
    process.kill(-child.pid, "SIGKILL");
    await child.exited;
  });
});
