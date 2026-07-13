import { afterEach, describe, expect, it } from "vitest";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const tempRoots: Array<string> = [];
const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const runRelay = async (
  root: string,
  args: ReadonlyArray<string>,
  cwd = projectRoot,
  env: Readonly<Record<string, string>> = {},
) => {
  try {
    const result = await execFileAsync("bun", [join(projectRoot, "src/cli.ts"), ...args], {
      cwd,
      env: { ...process.env, RELAY_DATA_DIR: root, NO_COLOR: "1", ...env },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; code?: number };
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code ?? 1 };
  }
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Relay CLI storage", () => {
  it("hands off only unseen context across a real Codex → OpenCode → Codex process flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-handoff-"));
    const bin = join(root, "bin");
    const trace = join(root, "trace.jsonl");
    tempRoots.push(root);
    await mkdir(bin);
    await Promise.all([
      copyFile(join(projectRoot, "test/fixtures/fake-codex-turn.ts"), join(bin, "codex")),
      copyFile(join(projectRoot, "test/fixtures/fake-opencode-turn.ts"), join(bin, "opencode")),
    ]);
    await Promise.all([chmod(join(bin, "codex"), 0o755), chmod(join(bin, "opencode"), 0o755)]);
    const env = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RELAY_TEST_TRACE: trace,
    };

    const doctor = await runRelay(root, ["doctor"], projectRoot, env);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain("codex      ready");
    expect(doctor.stdout).toContain("opencode   ready");

    expect((await runRelay(root, ["new", "Cross-harness flow"], projectRoot, env)).exitCode).toBe(
      0,
    );
    expect((await runRelay(root, ["ask", "C1"], projectRoot, env)).exitCode).toBe(0);
    expect(
      (await runRelay(root, ["ask", "--with", "opencode", "O1"], projectRoot, env)).exitCode,
    ).toBe(0);
    expect(
      (await runRelay(root, ["ask", "--with", "codex", "C2"], projectRoot, env)).exitCode,
    ).toBe(0);

    const events = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { harness: string; args: Array<string>; prompt: string });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ harness: "codex", prompt: "C1" });
    expect(events[1]?.prompt).toContain("C1");
    expect(events[1]?.prompt).toContain("Codex completed");
    expect(events[1]?.prompt).toContain("<relay_current_request>\nO1");
    expect(events[2]?.args).toContain("codex-native");
    expect(events[2]?.prompt).toContain("O1");
    expect(events[2]?.prompt).toContain("OpenCode completed");
    expect(events[2]?.prompt).toContain("<relay_current_request>\nC2");
    expect(events[2]?.prompt).not.toContain('<relay_message role="user" source="codex">\nC1');
    for (const event of events) {
      expect(event.args.join(" ")).not.toContain(event.prompt);
      expect(event.args.join(" ")).not.toContain("<relay_handoff");
    }

    const history = await runRelay(root, ["history"], projectRoot, env);
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain("C1");
    expect(history.stdout).toContain("O1");
    expect(history.stdout).toContain("C2");
    const native = await runRelay(root, ["native", "codex"], projectRoot, env);
    expect(native.exitCode).toBe(0);
    expect(native.stdout).toContain("resume 'codex-native'");
  }, 30_000);

  it("creates, switches, lists, and reopens a task without launching a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-test-"));
    tempRoots.push(root);

    const created = await runRelay(root, ["new", "Parser repair", "--with", "codex"]);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("Parser repair");
    const shortId = created.stdout.match(/[0-9a-f]{8}/)?.[0];
    expect(shortId).toBeDefined();

    const [threadId] = await readdir(join(root, "threads"));
    const privatePaths = [
      root,
      join(root, "threads"),
      join(root, "threads", threadId!),
      join(root, "index.json"),
      join(root, "threads", threadId!, "thread.json"),
      join(root, "threads", threadId!, "events.jsonl"),
    ];
    for (const path of privatePaths) {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode & 0o077, path).toBe(0);
    }

    const switched = await runRelay(root, ["use", "opencode"]);
    expect(switched.exitCode).toBe(0);
    expect(switched.stdout).toContain("opencode");

    const status = await runRelay(root, ["status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Parser repair");
    expect(status.stdout).toContain("not created");

    const listed = await runRelay(root, ["list"]);
    expect(listed.stdout).toContain("Parser repair");
    expect(listed.stdout).toContain("opencode");

    const selected = await runRelay(root, ["thread", shortId!]);
    expect(selected.stdout).toContain("Selected");

    await appendFile(join(root, "threads", threadId!, "events.jsonl"), '{"truncated":');
    const repaired = await runRelay(root, ["history"]);
    expect(repaired.exitCode).toBe(0);

    const wrongDirectory = await runRelay(root, ["ask", "Do not run"], tmpdir());
    expect(wrongDirectory.exitCode).toBe(1);
    expect(wrongDirectory.stderr).toContain("This task belongs to");
  }, 30_000);

  it("prints an actionable error when no task is selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-empty-"));
    tempRoots.push(root);
    const result = await runRelay(root, ["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Run relay new first");
  });

  it("defers current-task transcript recovery from listing to export", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-metadata-list-"));
    tempRoots.push(root);
    await runRelay(root, ["new", "Metadata only"]);
    const [threadId] = await readdir(join(root, "threads"));
    const events = join(root, "threads", threadId!, "events.jsonl");
    const partial = '{"id":"interrupted-tail"';
    await appendFile(events, partial);

    const listed = await runRelay(root, ["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("Metadata only");
    expect(await readFile(events, "utf8")).toBe(partial);

    const exported = await runRelay(root, ["export", "--out", join(root, "task.json")]);
    expect(exported.exitCode).toBe(0);
    expect((await readFile(events, "utf8")).trim()).toBe("");
  });

  it("lists and resolves tasks without scanning unrelated transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-metadata-resolution-"));
    tempRoots.push(root);
    await runRelay(root, ["new", "Unrelated broken task"]);
    const [unrelatedId] = await readdir(join(root, "threads"));
    const unrelatedEvents = join(root, "threads", unrelatedId!, "events.jsonl");
    const invalid = "not-json\n";
    await writeFile(unrelatedEvents, invalid);

    const created = await runRelay(root, ["new", "Clean target task"]);
    const targetId = created.stdout.match(/[0-9a-f]{8}/)?.[0];
    expect(targetId).toBeDefined();

    const listed = await runRelay(root, ["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("Unrelated broken task");
    expect(listed.stdout).toContain("Clean target task");

    const exported = await runRelay(root, [
      "export",
      targetId!,
      "--out",
      join(root, "target.json"),
    ]);
    expect(exported.exitCode).toBe(0);
    expect(await readFile(unrelatedEvents, "utf8")).toBe(invalid);
  });

  it("exports a versioned task and deletes only Relay-owned records", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-export-delete-"));
    tempRoots.push(root);
    const created = await runRelay(root, ["new", "Disposable task"]);
    const shortId = created.stdout.match(/[0-9a-f]{8}/)?.[0];
    const [threadId] = await readdir(join(root, "threads"));
    const output = join(root, "task-export.json");

    const exported = await runRelay(root, ["export", shortId!, "--out", output]);
    expect(exported.exitCode).toBe(0);
    const payload = JSON.parse(await readFile(output, "utf8")) as {
      formatVersion: number;
      task: { id: string; title: string };
      messages: Array<unknown>;
    };
    expect(payload).toMatchObject({
      formatVersion: 1,
      task: { id: threadId, title: "Disposable task" },
      messages: [],
    });
    expect((await stat(output)).mode & 0o077).toBe(0);

    const guarded = await runRelay(root, ["delete", shortId!]);
    expect(guarded.exitCode).toBe(1);
    expect(guarded.stderr).toContain("Re-run with --force");
    expect(await access(join(root, "threads", threadId!))).toBeUndefined();

    const deleted = await runRelay(root, ["delete", shortId!, "--force"]);
    expect(deleted.exitCode).toBe(0);
    await expect(access(join(root, "threads", threadId!))).rejects.toThrow();
    expect(
      (JSON.parse(await readFile(join(root, "index.json"), "utf8")) as { threadIds: [] }).threadIds,
    ).toEqual([]);
    expect((await runRelay(root, ["status"])).stderr).toContain("Run relay new first");
  });

  it("marks legacy storage as version 1 and rejects newer formats", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-storage-version-"));
    tempRoots.push(root);
    await mkdir(join(root, "threads"), { recursive: true });
    await writeFile(
      join(root, "index.json"),
      `${JSON.stringify({ currentThreadId: null, threadIds: [] })}\n`,
      { mode: 0o600 },
    );

    const migrated = await runRelay(root, ["list"]);
    expect(migrated.exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(root, "index.json"), "utf8"))).toEqual({
      version: 1,
      currentThreadId: null,
      threadIds: [],
    });

    await writeFile(
      join(root, "index.json"),
      `${JSON.stringify({ version: 99, currentThreadId: null, threadIds: [] })}\n`,
      {
        mode: 0o600,
      },
    );
    const rejected = await runRelay(root, ["list"]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("storage format 99");
  });

  it("finishes a journaled deletion after an interrupted delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-delete-recovery-"));
    tempRoots.push(root);
    await runRelay(root, ["new", "Interrupted deletion"]);
    const [threadId] = await readdir(join(root, "threads"));
    await mkdir(join(root, "deletions"), { recursive: true });
    await writeFile(
      join(root, "deletions", `${threadId}.json`),
      `${JSON.stringify({
        version: 1,
        threadId,
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const listed = await runRelay(root, ["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("No Relay tasks yet");
    await expect(access(join(root, "threads", threadId!))).rejects.toThrow();
    await expect(access(join(root, "deletions", `${threadId}.json`))).rejects.toThrow();
  });

  it("rejects a task file from a newer Relay without rewriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-task-version-"));
    tempRoots.push(root);
    await runRelay(root, ["new", "Future task"]);
    const [threadId] = await readdir(join(root, "threads"));
    const path = join(root, "threads", threadId!, "thread.json");
    const future = `${JSON.stringify({ ...(JSON.parse(await readFile(path, "utf8")) as object), version: 99 })}\n`;
    await writeFile(path, future, { mode: 0o600 });

    const status = await runRelay(root, ["status"]);
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain("task storage format 99");
    expect(await readFile(path, "utf8")).toBe(future);
  });

  it("recovers a journaled turn after a partial event-log write", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-recovery-"));
    tempRoots.push(root);
    await runRelay(root, ["new", "Recovery test"]);
    const [threadId] = await readdir(join(root, "threads"));
    const directory = join(root, "threads", threadId!);
    const thread = JSON.parse(await readFile(join(directory, "thread.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      seq: 1,
      role: "user",
      content: "Journaled request",
      harness: "codex",
      createdAt: now,
    };
    const response = {
      id: crypto.randomUUID(),
      seq: 2,
      role: "assistant",
      content: "Recovered response",
      harness: "codex",
      createdAt: now,
    };
    const updated = {
      ...thread,
      activeHarness: "codex",
      lastSeq: 2,
      updatedAt: now,
      bindings: {
        codex: {
          harness: "codex",
          sessionId: "codex-recovered",
          lastSyncedSeq: 2,
          createdAt: now,
          updatedAt: now,
        },
      },
    };
    await writeFile(
      join(directory, "pending-turn.json"),
      `${JSON.stringify({ version: 1, messages: [user, response], thread: updated })}\n`,
    );
    await writeFile(join(directory, "events.jsonl"), `${JSON.stringify(user)}\n{"partial":`);

    const history = await runRelay(root, ["history"]);
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain("Recovered response");
    await expect(access(join(directory, "pending-turn.json"))).rejects.toThrow();
  });

  it("rejects a concurrent turn before launching a harness", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-lock-"));
    tempRoots.push(root);
    await runRelay(root, ["new", "Lock test"]);
    const [threadId] = await readdir(join(root, "threads"));
    const lock = join(root, "locks", threadId!);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });

    const result = await runRelay(root, ["ask", "Must not launch"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already has a turn running");
  });

  it("does not repair a partial event while a live writer owns the task lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-live-writer-"));
    tempRoots.push(root);
    await runRelay(root, ["new", "Live writer test"]);
    const [threadId] = await readdir(join(root, "threads"));
    const events = join(root, "threads", threadId!, "events.jsonl");
    const partial = '{"id":"still-being-written"';
    await appendFile(events, partial);

    const lock = join(root, "locks", threadId!);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });

    const history = await runRelay(root, ["history"]);
    expect(history.exitCode).toBe(0);
    expect(await readFile(events, "utf8")).toBe(partial);
  });
});
