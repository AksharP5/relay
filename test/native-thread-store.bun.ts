import { afterAll, describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayThread } from "../src/domain.ts";
import type { ThreadLockOperations } from "../src/services/thread-store.ts";

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

  it("finishes a journaled context adoption before accepting a newer turn", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Crash-safe adoption",
          cwd: process.cwd(),
          harness: "codex",
        });
        const old = yield* store.commitTurn(created, {
          harness: "codex",
          prompt: "old prompt",
          response: "old response",
          sessionId: "old-session",
          bindingCreatedAt: created.createdAt,
        });
        const now = new Date().toISOString();
        const boundary = old.thread.lastSeq;
        const messages = [
          {
            id: "selected-user",
            seq: boundary + 1,
            role: "user" as const,
            content: "selected earlier",
            harness: "opencode" as const,
            nativeId: "selected-turn",
            nativeSessionId: "selected-session",
            createdAt: now,
          },
          {
            id: "selected-assistant",
            seq: boundary + 2,
            role: "assistant" as const,
            content: "selected response",
            harness: "opencode" as const,
            nativeId: "selected-turn",
            nativeSessionId: "selected-session",
            createdAt: now,
          },
        ];
        const selected = {
          ...old.thread,
          activeHarness: "opencode" as const,
          contextStartSeq: boundary,
          lastSeq: boundary + 2,
          bindings: {
            opencode: {
              harness: "opencode" as const,
              sessionId: "selected-session",
              lastSyncedSeq: boundary + 2,
              nativeCursor: "selected-turn",
              createdAt: now,
              updatedAt: now,
            },
          },
          pendingHandoffs: {},
          updatedAt: now,
        };
        const pending = join(directory, "threads", created.id, "pending-turn.json");
        yield* Effect.promise(() =>
          writeFile(
            pending,
            `${JSON.stringify({
              version: 1,
              messages,
              thread: selected,
              replaceEvents: true,
              visibility: { hidden: [], links: [] },
            })}\n`,
            { encoding: "utf8", mode: 0o600 },
          ),
        );

        const recovered = yield* store.get(created.id);
        const next = yield* store.commitTurn(recovered, {
          harness: "opencode",
          prompt: "new headless",
          response: "new response",
          sessionId: "selected-session",
          bindingCreatedAt: recovered.bindings.opencode!.createdAt,
        });

        expect(next.thread.lastSeq).toBe(boundary + 4);
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "selected earlier",
          "selected response",
          "new headless",
          "new response",
        ]);
        expect(yield* Effect.promise(() => Bun.file(pending).exists())).toBe(false);
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

  it("discards malformed lock claims without a starting grace period", async () => {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return yield* store.create({
          title: "Malformed lease claim",
          cwd: process.cwd(),
          harness: "codex",
        });
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
    const claims = join(directory, "run-locks", created.id);
    await mkdir(claims, { recursive: true });
    await writeFile(join(claims, "owner.json"), `${JSON.stringify({ pid: "invalid" })}\n`);

    const lease = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return yield* store.acquireRunLease(created.id);
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
    await lease.release();
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

  it("returns a schema-valid task when binding clears a pending handoff", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Schema-valid bind",
          cwd: process.cwd(),
          harness: "codex",
        });
        const codexPending = yield* store.beginNativeHandoff(created, {
          harness: "codex",
          fromSeq: 0,
          throughSeq: 0,
        });
        const bothPending = yield* store.beginNativeHandoff(codexPending, {
          harness: "opencode",
          fromSeq: 0,
          throughSeq: 0,
        });

        const bound = yield* store.bindNativeSession(bothPending, {
          harness: "codex",
          sessionId: "codex-session",
          lastSyncedSeq: 0,
        });

        expect(Schema.is(RelayThread)(bound)).toBe(true);
        expect(Object.hasOwn(bound.pendingHandoffs ?? {}, "codex")).toBe(false);
        expect(bound.pendingHandoffs?.opencode).toBeDefined();
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
  });

  it("returns a schema-valid task when abandoning a pending handoff", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Schema-valid abandon",
          cwd: process.cwd(),
          harness: "codex",
        });
        const adopted = yield* store.resetNativeContext(created, {
          harness: "codex",
          sessionId: "codex-session",
          turns: [],
        });
        const codexPending = yield* store.beginNativeHandoff(adopted, {
          harness: "codex",
          sessionId: "codex-session",
          fromSeq: 0,
          throughSeq: 0,
        });
        const bothPending = yield* store.beginNativeHandoff(codexPending, {
          harness: "opencode",
          fromSeq: 0,
          throughSeq: 0,
        });

        const abandoned = yield* store.abandonNativeHandoff(bothPending, "codex");

        expect(Schema.is(RelayThread)(abandoned)).toBe(true);
        expect(Object.hasOwn(abandoned.pendingHandoffs ?? {}, "codex")).toBe(false);
        expect(abandoned.pendingHandoffs?.opencode).toBeDefined();
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
  });

  it("returns a schema-valid task when dropping a binding", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Schema-valid drop",
          cwd: process.cwd(),
          harness: "codex",
        });
        const adopted = yield* store.resetNativeContext(created, {
          harness: "codex",
          sessionId: "codex-session",
          turns: [],
        });
        const codexPending = yield* store.beginNativeHandoff(adopted, {
          harness: "codex",
          sessionId: "codex-session",
          fromSeq: 0,
          throughSeq: 0,
        });
        const bothPending = yield* store.beginNativeHandoff(codexPending, {
          harness: "opencode",
          fromSeq: 0,
          throughSeq: 0,
        });

        const dropped = yield* store.dropBinding(bothPending, "codex");

        expect(Schema.is(RelayThread)(dropped)).toBe(true);
        expect(Object.hasOwn(dropped.pendingHandoffs ?? {}, "codex")).toBe(false);
        expect(dropped.pendingHandoffs?.opencode).toBeDefined();
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
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

  it("recovers a visibility-only import after metadata persistence fails", async () => {
    const keepTurn = { id: "native-keep", prompt: "keep", response: "kept" };
    const hiddenTurn = { id: "native-hide", prompt: "hide", response: "hidden" };
    const prepared = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Crash-safe native visibility",
          cwd: process.cwd(),
          harness: "opencode",
        });
        const imported = yield* store.importNativeTurns(created, {
          harness: "opencode",
          sessionId: "opencode-visibility-session",
          turns: [keepTurn, hiddenTurn],
          hiddenTurnIds: [],
        });
        const handedOff = yield* store.bindNativeSession(imported, {
          harness: "codex",
          sessionId: "codex-stale-session",
          lastSyncedSeq: imported.lastSeq,
        });
        return { created, handedOff };
      }).pipe(Effect.provide(ThreadStore.layerFromRoot(directory))),
    );

    const taskDirectory = join(directory, "threads", prepared.created.id);
    const metadata = join(taskDirectory, "thread.json");
    const pending = join(taskDirectory, "pending-turn.json");
    const visibilityFile = join(taskDirectory, "native-visibility.json");
    const metadataSource = await readFile(metadata, "utf8");

    await rm(metadata);
    await mkdir(metadata);
    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            return yield* store.importNativeTurns(prepared.handedOff, {
              harness: "opencode",
              sessionId: "opencode-visibility-session",
              turns: [keepTurn],
              hiddenTurnIds: [hiddenTurn.id],
            });
          }).pipe(Effect.provide(ThreadStore.layerFromRoot(directory))),
        ),
      ).rejects.toThrow();

      expect(await Bun.file(pending).exists()).toBe(true);
      const visibilitySource: unknown = JSON.parse(await readFile(visibilityFile, "utf8"));
      const persistedVisibility = Schema.decodeUnknownSync(
        Schema.Struct({
          hidden: Schema.Array(Schema.String),
          links: Schema.Array(Schema.Struct({ messageId: Schema.String, key: Schema.String })),
        }),
      )(visibilitySource);
      expect(persistedVisibility.hidden).toEqual([
        "opencode:opencode-visibility-session:native-hide",
      ]);
    } finally {
      await rm(metadata, { recursive: true, force: true });
      await writeFile(metadata, metadataSource, { encoding: "utf8", mode: 0o600 });
    }

    const freshTurn = { id: "native-fresh", prompt: "fresh", response: "new" };
    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const thread = yield* store.importNativeTurns(prepared.handedOff, {
          harness: "opencode",
          sessionId: "opencode-visibility-session",
          turns: [keepTurn, freshTurn],
          hiddenTurnIds: [hiddenTurn.id],
        });
        const messages = yield* store.messages(prepared.created.id);
        return { thread, messages };
      }).pipe(Effect.provide(ThreadStore.layerFromRoot(directory))),
    );

    expect(recovered.thread.bindings.codex).toBeUndefined();
    expect(recovered.thread.bindings.opencode?.sessionId).toBe("opencode-visibility-session");
    expect(recovered.messages.map((message) => message.content)).toEqual([
      "keep",
      "kept",
      "fresh",
      "new",
    ]);
    expect(await Bun.file(pending).exists()).toBe(false);
  });

  it("re-adopts a redone OpenCode transcript without stale context tombstones", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Re-adopt native redo",
          cwd: process.cwd(),
          harness: "opencode",
        });
        const turns = [
          { id: "native-1", prompt: "keep", response: "kept" },
          { id: "native-2", prompt: "redo", response: "redone" },
        ];
        const imported = yield* store.importNativeTurns(created, {
          harness: "opencode",
          sessionId: "session-a",
          turns,
          hiddenTurnIds: [],
        });
        const undone = yield* store.importNativeTurns(imported, {
          harness: "opencode",
          sessionId: "session-a",
          turns: [turns[0]!],
          hiddenTurnIds: [turns[1]!.id],
        });

        const selectedB = yield* store.resetNativeContext(undone, {
          harness: "opencode",
          sessionId: "session-b",
          turns: [{ id: "native-b", prompt: "other", response: "context" }],
        });
        const recoveredB = yield* store.get(created.id);
        expect(recoveredB.lastSeq).toBe(selectedB.lastSeq);
        expect(recoveredB.contextStartSeq).toBe(selectedB.contextStartSeq);
        const importedB = recoveredB;
        const selectedA = yield* store.resetNativeContext(importedB, {
          harness: "opencode",
          sessionId: "session-a",
          nativeCursor: turns.at(-1)!.id,
          turns: [],
        });
        yield* Effect.promise(() =>
          writeFile(
            join(directory, "threads", created.id, "native-visibility.json"),
            `${JSON.stringify({ hidden: ["opencode:session-a:native-2"], links: [] })}\n`,
            { encoding: "utf8", mode: 0o600 },
          ),
        );
        const redone = yield* store.importNativeTurns(selectedA, {
          harness: "opencode",
          sessionId: "session-a",
          turns,
          hiddenTurnIds: [],
        });

        expect(redone.contextStartSeq).toBe(6);
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "keep",
          "kept",
          "redo",
          "redone",
        ]);
        expect(
          (yield* store.messagesSince(created.id, 0)).messages.map((message) => message.content),
        ).toEqual(["keep", "kept", "redo", "redone"]);

        const events = yield* Effect.promise(() =>
          readFile(join(directory, "threads", created.id, "events.jsonl"), "utf8"),
        );
        expect(events).not.toContain("other");
        expect(events.trimEnd().split("\n")).toHaveLength(4);
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

const StoredLockClaim = Schema.Struct({
  pid: Schema.Number,
  startedAt: Schema.String,
  token: Schema.String,
  createdAt: Schema.String,
});

const onlyLockClaim = async (path: string) => {
  const entries = (await readdir(path)).filter((entry) => entry.endsWith(".json"));
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (entry === undefined) throw new Error(`Expected a lock claim in ${path}`);
  return join(path, entry);
};

const lockOperations = (identities: ReadonlyMap<number, string>): ThreadLockOperations => ({
  processStartIdentity: async (pid) => identities.get(pid),
});

describe("thread store lock ownership", () => {
  it("records the owner process start identity in new claims", async () => {
    const root = await mkdtemp(join(directory, "lock-owner-identity-"));
    const identities = new Map([[process.pid, "owner-start"]]);
    const lease = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return yield* store.acquireLock("identity-claim");
      }).pipe(
        Effect.provide(
          ThreadStore.layerFromRoot(root, { lockOperations: lockOperations(identities) }),
        ),
      ),
    );

    const claimPath = await onlyLockClaim(join(root, "locks", "identity-claim"));
    const claim = Schema.decodeUnknownSync(StoredLockClaim)(
      JSON.parse(await readFile(claimPath, "utf8")),
    );
    expect(claim.pid).toBe(process.pid);
    expect(claim.startedAt).toBe("owner-start");
    await lease.release();
  });

  it("includes the Linux boot identity in live process claims", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(directory, "lock-linux-boot-identity-"));
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const lease = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return yield* store.acquireLock("linux-boot-identity");
      }).pipe(Effect.provide(ThreadStore.layerFromRoot(root))),
    );

    const claimPath = await onlyLockClaim(join(root, "locks", "linux-boot-identity"));
    const claim = Schema.decodeUnknownSync(StoredLockClaim)(
      JSON.parse(await readFile(claimPath, "utf8")),
    );
    expect(claim.startedAt).toMatch(new RegExp(`^linux:${bootId}:\\d+$`));
    await lease.release();
  });

  it("reclaims a live PID when its process start identity does not match", async () => {
    const root = await mkdtemp(join(directory, "lock-reused-pid-"));
    const threadId = "reused-pid";
    const reusedPid = 42_424;
    const claimDirectory = join(root, "run-locks", threadId);
    const staleClaim = join(claimDirectory, "stale.json");
    await mkdir(claimDirectory, { recursive: true });
    await writeFile(
      staleClaim,
      `${JSON.stringify({
        pid: reusedPid,
        startedAt: "original-start",
        token: "stale",
        createdAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );
    const identities = new Map([
      [process.pid, "contender-start"],
      [reusedPid, "replacement-start"],
    ]);

    const lease = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return yield* store.acquireRunLease(threadId);
      }).pipe(
        Effect.provide(
          ThreadStore.layerFromRoot(root, { lockOperations: lockOperations(identities) }),
        ),
      ),
    );
    expect(await Bun.file(staleClaim).exists()).toBe(false);
    await lease.release();
  });

  it("keeps a matching live process identity busy", async () => {
    const root = await mkdtemp(join(directory, "lock-matching-owner-"));
    const threadId = "matching-owner";
    const ownerPid = 52_525;
    const claimDirectory = join(root, "run-locks", threadId);
    await mkdir(claimDirectory, { recursive: true });
    await writeFile(
      join(claimDirectory, "owner.json"),
      `${JSON.stringify({
        pid: ownerPid,
        startedAt: "matching-start",
        token: "owner",
        createdAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );
    const identities = new Map([
      [process.pid, "contender-start"],
      [ownerPid, "matching-start"],
    ]);

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.acquireRunLease(threadId);
        }).pipe(
          Effect.provide(
            ThreadStore.layerFromRoot(root, { lockOperations: lockOperations(identities) }),
          ),
        ),
      ),
    ).rejects.toThrow("already open");
    expect((await readdir(claimDirectory)).filter((entry) => entry.endsWith(".json"))).toEqual([
      "owner.json",
    ]);
  });

  it("keeps a claim when its process identity cannot be inspected", async () => {
    const root = await mkdtemp(join(directory, "lock-owner-lookup-failure-"));
    const threadId = "owner-lookup-failure";
    const ownerPid = 53_535;
    const claimDirectory = join(root, "run-locks", threadId);
    const ownerClaim = join(claimDirectory, "owner.json");
    await mkdir(claimDirectory, { recursive: true });
    await writeFile(
      ownerClaim,
      `${JSON.stringify({
        pid: ownerPid,
        startedAt: "owner-start",
        token: "owner",
        createdAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );
    const operations: ThreadLockOperations = {
      processStartIdentity: async (pid) => {
        if (pid === process.pid) return "contender-start";
        throw new Error("identity lookup denied");
      },
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.acquireRunLease(threadId);
        }).pipe(Effect.provide(ThreadStore.layerFromRoot(root, { lockOperations: operations }))),
      ),
    ).rejects.toThrow("identity lookup denied");
    expect(await Bun.file(ownerClaim).exists()).toBe(true);
    expect((await readdir(claimDirectory)).filter((entry) => entry.endsWith(".json"))).toEqual([
      "owner.json",
    ]);
  });

  it("keeps a live legacy PID claim but reclaims it after that PID exits", async () => {
    const root = await mkdtemp(join(directory, "lock-legacy-owner-"));
    const threadId = "legacy-owner";
    const legacyPid = 62_626;
    const claimDirectory = join(root, "run-locks", threadId);
    const legacyClaim = join(claimDirectory, "owner.json");
    await mkdir(claimDirectory, { recursive: true });
    await writeFile(
      legacyClaim,
      `${JSON.stringify({
        pid: legacyPid,
        token: "legacy",
        createdAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );
    const identities = new Map([
      [process.pid, "contender-start"],
      [legacyPid, "legacy-live-start"],
    ]);
    const layer = ThreadStore.layerFromRoot(root, {
      lockOperations: lockOperations(identities),
    });
    const acquire = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          return yield* store.acquireRunLease(threadId);
        }).pipe(Effect.provide(layer)),
      );

    await expect(acquire()).rejects.toThrow("already open");
    identities.delete(legacyPid);
    const lease = await acquire();
    expect(await Bun.file(legacyClaim).exists()).toBe(false);
    await lease.release();
  });

  it("does not release a claim after the owner process identity changes", async () => {
    const root = await mkdtemp(join(directory, "lock-release-owner-"));
    const threadId = "release-owner";
    const identities = new Map([[process.pid, "original-owner"]]);
    const lease = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        return yield* store.acquireRunLease(threadId);
      }).pipe(
        Effect.provide(
          ThreadStore.layerFromRoot(root, { lockOperations: lockOperations(identities) }),
        ),
      ),
    );
    const claimPath = await onlyLockClaim(join(root, "run-locks", threadId));

    identities.set(process.pid, "replacement-owner");
    await lease.release();
    expect(await Bun.file(claimPath).exists()).toBe(true);
  });
});
