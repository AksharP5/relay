import { afterAll, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "relay-process-registry-"));
Bun.env.RELAY_DATA_DIR = directory;
const {
  cleanupOrphanedProcesses,
  ProcessRecoveryError,
  ProcessRecoveryFailure,
  trackManagedProcess,
} = await import("../src/services/process-registry.ts");
const { renderProcessRecoveryError } = await import("../src/cli.ts");

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
  it("renders process and process-group identities with safe scope-specific remediation", () => {
    const processFailure = ProcessRecoveryFailure.make({
      claimFile: "reader.json",
      claimToken: "reader-token",
      kind: "terminal-reader",
      scope: "process",
      pid: 4242,
      startedAt: "process-start",
    });
    const groupFailure = ProcessRecoveryFailure.make({
      claimFile: "command.json",
      claimToken: "command-token",
      kind: "command",
      scope: "group",
      pid: 5252,
      pgid: 5353,
      startedAt: "group-leader-start",
    });

    const output = renderProcessRecoveryError(
      new ProcessRecoveryError({ failures: [processFailure, groupFailure] }),
    );

    expect(output).toContain('Claim file "reader.json" · token "reader-token"');
    expect(output).toContain('Kind "terminal-reader" · scope process');
    expect(output).toContain('Identity PID 4242, start "process-start"');
    expect(output).toContain("Never signal a reused PID.");
    expect(output).toContain('Claim file "command.json" · token "command-token"');
    expect(output).toContain('Kind "command" · scope group');
    expect(output).toContain('Identity leader PID 5252, PGID 5353, start "group-leader-start"');
    expect(output).toContain("Never signal a reused process group.");
    expect(output.match(/Relay kept this claim for a later retry\./g)).toHaveLength(2);
  });

  it("returns actionable identity and retains a failed process claim for retry", async () => {
    const processes = join(directory, "processes");
    await mkdir(processes, { recursive: true, mode: 0o700 });
    const claimFile = "blocked-process.json";
    const claimPath = join(processes, claimFile);
    await writeFile(
      claimPath,
      `${JSON.stringify({
        version: 1,
        token: "blocked-process",
        owner: { pid: 9001, startedAt: "former-owner" },
        child: { pid: 4242, pgid: 4343, startedAt: "fixture-start" },
        scope: "process",
        kind: "terminal-reader",
        createdAt: "2026-07-20T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    const signals: Array<readonly [number, NodeJS.Signals]> = [];
    const result = await cleanupOrphanedProcesses({
      operations: {
        processSnapshot: async (pid) =>
          pid === 4242 ? { pgid: 4343, startedAt: "fixture-start" } : undefined,
        signalGroup: () => {
          throw new Error("process-scoped recovery must not signal a group");
        },
        signalProcess: (pid, signal) => {
          signals.push([pid, signal]);
        },
        groupIsAlive: () => false,
        waitForGroupExit: async () => false,
        waitForProcessExit: async () => false,
      },
    });

    expect(signals).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      {
        claimFile,
        claimToken: "blocked-process",
        kind: "terminal-reader",
        scope: "process",
        pid: 4242,
        startedAt: "fixture-start",
      },
    ]);
    expect(await readFile(claimPath, "utf8")).toContain('"token":"blocked-process"');
    await rm(claimPath);
  });

  it("preserves PGID details when a process-group claim cannot be recovered", async () => {
    const processes = join(directory, "processes");
    await mkdir(processes, { recursive: true, mode: 0o700 });
    const claimFile = "blocked-group.json";
    const claimPath = join(processes, claimFile);
    await writeFile(
      claimPath,
      `${JSON.stringify({
        version: 1,
        token: "blocked-group",
        owner: { pid: 9001, startedAt: "former-owner" },
        child: { pid: 5252, pgid: 5353, startedAt: "group-leader-start" },
        scope: "group",
        kind: "command",
        createdAt: "2026-07-20T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    const signals: Array<readonly [number, NodeJS.Signals]> = [];
    const result = await cleanupOrphanedProcesses({
      operations: {
        processSnapshot: async (pid) =>
          pid === 5252 ? { pgid: 5353, startedAt: "group-leader-start" } : undefined,
        signalGroup: (pgid, signal) => {
          signals.push([pgid, signal]);
        },
        signalProcess: () => {
          throw new Error("group-scoped recovery must not signal one process");
        },
        groupIsAlive: () => false,
        waitForGroupExit: async () => false,
        waitForProcessExit: async () => false,
      },
    });

    expect(signals).toEqual([
      [5353, "SIGTERM"],
      [5353, "SIGKILL"],
    ]);
    expect(result.failures).toEqual([
      {
        claimFile,
        claimToken: "blocked-group",
        kind: "command",
        scope: "group",
        pid: 5252,
        pgid: 5353,
        startedAt: "group-leader-start",
      },
    ]);
    expect(await readFile(claimPath, "utf8")).toContain('"token":"blocked-group"');
    await rm(claimPath);
  });

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
        scope: "group",
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

  it("recovers a non-detached terminal reader without signaling its shared group", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await trackManagedProcess(child, "process-only-test", { processOnly: true });
    const processes = join(directory, "processes");
    const [claimName] = (await readdir(processes)).filter((name) => name.endsWith(".json"));
    const claimPath = join(processes, claimName!);
    const claim = JSON.parse(await readFile(claimPath, "utf8")) as {
      scope: string;
      owner: { pid: number; startedAt: string };
    };
    expect(claim.scope).toBe("process");
    claim.owner = { pid: 2_147_483_647, startedAt: "never" };
    await writeFile(claimPath, `${JSON.stringify(claim)}\n`, { mode: 0o600 });

    const result = await cleanupOrphanedProcesses();
    expect(result.terminated).toBe(1);
    expect(await child.exited).not.toBe(0);
  });

  it("stops a surviving descendant after its registered group leader exits", async () => {
    const ready = join(directory, "descendant-ready.json");
    const leader = Bun.spawn(
      [process.execPath, new URL("fixtures/managed-exiting-leader.ts", import.meta.url).pathname],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...Bun.env, RELAY_TEST_READY: ready },
        detached: true,
      },
    );
    await trackManagedProcess(leader, "exiting-leader-test");
    await waitFor(async () => Bun.file(ready).exists());
    const { descendantPid } = JSON.parse(await readFile(ready, "utf8")) as {
      descendantPid: number;
    };
    await leader.exited;
    expect(processIsAlive(descendantPid)).toBe(true);

    const processes = join(directory, "processes");
    const [claimName] = (await readdir(processes)).filter((name) => name.endsWith(".json"));
    const claimPath = join(processes, claimName!);
    const claim = JSON.parse(await readFile(claimPath, "utf8")) as {
      owner: { pid: number; startedAt: string };
      scope?: string;
    };
    claim.owner = { pid: 2_147_483_647, startedAt: "never" };
    delete claim.scope;
    await writeFile(claimPath, `${JSON.stringify(claim)}\n`, { mode: 0o600 });

    const result = await cleanupOrphanedProcesses();
    expect(result.terminated).toBe(1);
    await waitFor(async () => !processIsAlive(descendantPid));
  });
});
