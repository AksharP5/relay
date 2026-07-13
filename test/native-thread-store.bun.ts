import { afterAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
