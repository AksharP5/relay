import { afterAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "relay-native-store-"));
Bun.env.RELAY_DATA_DIR = directory;
const { ThreadStore } = await import("../src/services/thread-store.ts");

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  delete Bun.env.RELAY_DATA_DIR;
});

describe("native transcript storage", () => {
  it("indexes every concurrently created task without leaving orphans", async () => {
    const create = (index: number) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.create({
            title: `Concurrent task ${index}`,
            cwd: process.cwd(),
            harness: "codex",
          });
        }).pipe(Effect.provide(ThreadStore.layer)),
      );
    const created = await Promise.all(Array.from({ length: 30 }, (_, index) => create(index)));
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return yield* store.list();
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
    const listedIds = new Set(listed.map((thread) => thread.id));
    expect(created.every((thread) => listedIds.has(thread.id))).toBe(true);
  });

  it("rejects stale export and selection after a task is deleted", async () => {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const thread = yield* store.create({
          title: "Race victim",
          cwd: process.cwd(),
          harness: "codex",
        });
        yield* store.deleteTask(thread);
        return thread;
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.exportTask(created);
        }).pipe(Effect.provide(ThreadStore.layer)),
      ),
    ).rejects.toThrow("no longer exists");
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.setCurrent(created.id);
        }).pipe(Effect.provide(ThreadStore.layer)),
      ),
    ).rejects.toThrow("was not found");
  });

  it("repairs a valid unterminated event before appending the next turn", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Unterminated tail",
          cwd: process.cwd(),
          harness: "codex",
        });
        const first = yield* store.commitTurn(created, {
          harness: "codex",
          prompt: "first",
          response: "response one",
          sessionId: "tail-session",
          bindingCreatedAt: created.createdAt,
        });
        const events = join(directory, "threads", created.id, "events.jsonl");
        const firstEvents = yield* Effect.promise(() => readFile(events, "utf8"));
        yield* Effect.promise(() =>
          writeFile(events, firstEvents.trimEnd(), {
            mode: 0o600,
          }),
        );

        const recovered = yield* store.get(created.id);
        yield* store.commitTurn(recovered, {
          harness: "codex",
          prompt: "second",
          response: "response two",
          sessionId: "tail-session",
          bindingCreatedAt: first.thread.bindings.codex!.createdAt,
        });
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "first",
          "response one",
          "second",
          "response two",
        ]);
        const repairedEvents = yield* Effect.promise(() => readFile(events, "utf8"));
        expect(repairedEvents.endsWith("\n")).toBe(true);
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
  });

  it("prevents two Relay tasks from running in the same checkout", async () => {
    const checkout = join(directory, "checkout-lease-fixture");
    const nested = join(checkout, "packages", "app");
    await mkdir(join(checkout, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const { first, second } = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const first = yield* store.create({
          title: "First checkout owner",
          cwd: checkout,
          harness: "codex",
        });
        const second = yield* store.create({
          title: "Second checkout owner",
          cwd: nested,
          harness: "opencode",
        });
        return { first, second };
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
    const acquire = (thread: typeof first) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.acquireExecutionLease(thread);
        }).pipe(Effect.provide(ThreadStore.layer)),
      );
    const owner = await acquire(first);
    await expect(acquire(second)).rejects.toThrow("checkout is already active");
    await owner.release();
    const next = await acquire(second);
    await next.release();
  });

  it("recovers a stale run lease without allowing concurrent owners", async () => {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return yield* store.create({
          title: "Lease race",
          cwd: process.cwd(),
          harness: "codex",
        });
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
    const stale = join(directory, "run-locks", created.id);
    await mkdir(stale, { recursive: true });
    await writeFile(
      join(stale, "owner.json"),
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: "2020-01-01T00:00:00.000Z" })}\n`,
    );

    const acquire = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.acquireRunLease(created.id);
        }).pipe(Effect.provide(ThreadStore.layer)),
      );
    const attempts = await Promise.allSettled(Array.from({ length: 50 }, acquire));
    const owners = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : [],
    );
    expect(owners.length).toBeLessThanOrEqual(1);
    await Promise.all(owners.map((owner) => owner.release()));

    const retry = await acquire();
    await retry.release();
  });

  it("releasing an old lease cannot remove a newer owner's claim", async () => {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return yield* store.create({
          title: "Lease ownership",
          cwd: process.cwd(),
          harness: "codex",
        });
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
    const acquire = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.acquireRunLease(created.id);
        }).pipe(Effect.provide(ThreadStore.layer)),
      );

    const first = await acquire();
    await first.release();
    const second = await acquire();
    await first.release();
    await expect(acquire()).rejects.toThrow("already open");
    await second.release();
  });

  it("binds an empty session and idempotently imports native turns", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "New Relay task",
          cwd: process.cwd(),
          harness: "codex",
        });
        const bound = yield* store.bindNativeSession(created, {
          harness: "codex",
          sessionId: "codex-session",
          lastSyncedSeq: 0,
        });
        expect(bound.bindings.codex?.sessionId).toBe("codex-session");

        const turn = { id: "native-turn", prompt: "Fix parser", response: "Parser fixed." };
        const imported = yield* store.importNativeTurns(bound, {
          harness: "codex",
          sessionId: "codex-session",
          turns: [turn],
        });
        expect(imported.title).toBe("Fix parser");
        expect(imported.lastSeq).toBe(2);
        expect(imported.bindings.codex?.nativeCursor).toBe("native-turn");
        expect(imported.bindings.codex?.lastSyncedSeq).toBe(2);

        const repeated = yield* store.importNativeTurns(imported, {
          harness: "codex",
          sessionId: "codex-session",
          turns: [turn],
        });
        expect(repeated.lastSeq).toBe(2);
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "Fix parser",
          "Parser fixed.",
        ]);
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
  });

  it("hides and restores native OpenCode turns without renumbering history", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Native undo",
          cwd: process.cwd(),
          harness: "opencode",
        });
        const turns = [
          { id: "native-1", prompt: "keep", response: "kept" },
          { id: "native-2", prompt: "undo", response: "undone" },
        ];
        const imported = yield* store.importNativeTurns(created, {
          harness: "opencode",
          sessionId: "opencode-session",
          turns,
          hiddenTurnIds: [],
        });
        const handedOff = yield* store.bindNativeSession(imported, {
          harness: "codex",
          sessionId: "codex-session",
          lastSyncedSeq: imported.lastSeq,
        });

        const undone = yield* store.importNativeTurns(handedOff, {
          harness: "opencode",
          sessionId: "opencode-session",
          turns: [turns[0]!],
          hiddenTurnIds: [turns[1]!.id],
        });
        expect(undone.lastSeq).toBe(4);
        expect(undone.bindings.codex).toBeUndefined();
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "keep",
          "kept",
        ]);
        expect(
          (yield* store.messagesSince(created.id, 0)).messages.map((message) => message.content),
        ).toEqual(["keep", "kept"]);

        const reopenedCodex = yield* store.bindNativeSession(undone, {
          harness: "codex",
          sessionId: "codex-after-undo",
          lastSyncedSeq: undone.lastSeq,
        });

        const redone = yield* store.importNativeTurns(reopenedCodex, {
          harness: "opencode",
          sessionId: "opencode-session",
          turns,
          hiddenTurnIds: [],
        });
        expect(redone.lastSeq).toBe(4);
        expect(redone.bindings.codex).toBeUndefined();
        expect(
          (yield* store.messagesSince(created.id, 0)).messages.map((message) => message.content),
        ).toEqual(["keep", "kept", "undo", "undone"]);
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "keep",
          "kept",
          "undo",
          "undone",
        ]);
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
  });

  it("links a headless turn to its native id instead of importing it twice", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Headless then native",
          cwd: process.cwd(),
          harness: "codex",
        });
        const committed = yield* store.commitTurn(created, {
          harness: "codex",
          prompt: "same prompt",
          response: "same response",
          sessionId: "codex-session",
          bindingCreatedAt: created.createdAt,
        });
        const linked = yield* store.importNativeTurns(committed.thread, {
          harness: "codex",
          sessionId: "codex-session",
          turns: [{ id: "native-turn", prompt: "same prompt", response: "same response" }],
          hiddenTurnIds: [],
        });
        expect(linked.lastSeq).toBe(2);
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "same prompt",
          "same response",
        ]);

        yield* store.importNativeTurns(linked, {
          harness: "codex",
          sessionId: "codex-session",
          turns: [],
          hiddenTurnIds: ["native-turn"],
        });
        expect(yield* store.messages(created.id)).toEqual([]);
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
  });
});
