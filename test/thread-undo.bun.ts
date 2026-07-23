import { afterAll, describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayMessage, RelayThread } from "../src/domain.ts";
import {
  ThreadStore,
  type ThreadStoreTestHooks,
  type UndoRedoPersistenceBoundary,
} from "../src/services/thread-store.ts";

const directory = await mkdtemp(join(tmpdir(), "relay-undo-"));
const StoredUndoFixture = Schema.Struct({ entries: Schema.Array(Schema.Unknown) });
const undoRedoBoundaries: ReadonlyArray<UndoRedoPersistenceBoundary> = [
  "before-journal",
  "journal",
  "events",
  "metadata",
  "visibility",
  "undo-state",
  "committed",
];

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const failAtBoundary = (target: UndoRedoPersistenceBoundary): ThreadStoreTestHooks => ({
  onUndoRedoPersistenceBoundary: (boundary) => {
    if (boundary === target) throw new Error(`Injected interruption at ${boundary}`);
  },
});

const createTwoTurns = (root: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const created = yield* store.create({
        title: "Undo transaction test",
        cwd: process.cwd(),
        harness: "opencode",
      });
      const first = yield* store.commitTurn(created, {
        harness: "opencode",
        prompt: "first",
        response: "first response",
        sessionId: "ses_transaction",
        bindingCreatedAt: created.createdAt,
      });
      const second = yield* store.commitTurn(first.thread, {
        harness: "opencode",
        prompt: "second",
        response: "second response",
        sessionId: "ses_transaction",
        bindingCreatedAt: created.createdAt,
      });
      return {
        thread: second.thread,
        messages: yield* store.messages(created.id),
      };
    }).pipe(Effect.provide(ThreadStore.layerFromRoot(root))),
  );

const interruptUndo = (root: string, thread: RelayThread, boundary: UndoRedoPersistenceBoundary) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      return yield* Effect.exit(store.undoLastTurn(thread, "opencode"));
    }).pipe(Effect.provide(ThreadStore.layerFromRoot(root, failAtBoundary(boundary)))),
  );

const interruptRedo = (root: string, thread: RelayThread, boundary: UndoRedoPersistenceBoundary) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      return yield* Effect.exit(store.redoLastTurn(thread, "opencode"));
    }).pipe(Effect.provide(ThreadStore.layerFromRoot(root, failAtBoundary(boundary)))),
  );

const recover = (root: string, threadId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const thread = yield* store.get(threadId);
      return {
        thread,
        messages: yield* store.messages(threadId),
        canRedo: yield* store.canRedoLastTurn(thread, "opencode"),
      };
    }).pipe(Effect.provide(ThreadStore.layerFromRoot(root))),
  );

const expectCanonicalIdentities = (messages: ReadonlyArray<RelayMessage>) => {
  expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
  expect(new Set(messages.map((message) => message.seq)).size).toBe(messages.length);
};

describe("canonical undo and redo", () => {
  it("keeps Relay history aligned with an OpenCode native revert", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Undo test",
          cwd: process.cwd(),
          harness: "opencode",
        });
        const first = yield* store.commitTurn(created, {
          harness: "opencode",
          prompt: "first",
          response: "first response",
          sessionId: "ses_test",
          bindingCreatedAt: created.createdAt,
        });
        const second = yield* store.commitTurn(first.thread, {
          harness: "opencode",
          prompt: "second",
          response: "second response",
          sessionId: "ses_test",
          bindingCreatedAt: created.createdAt,
        });

        const undone = yield* store.undoLastTurn(second.thread, "opencode");
        expect(undone.lastSeq).toBe(2);
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "first",
          "first response",
        ]);

        const redone = yield* store.redoLastTurn(undone, "opencode");
        expect(redone.lastSeq).toBe(4);
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "first",
          "first response",
          "second",
          "second response",
        ]);
      }).pipe(Effect.provide(ThreadStore.layerFromRoot(directory))),
    );
  });

  it("invalidates redo before adopting a different native context", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Undo adoption boundary",
          cwd: process.cwd(),
          harness: "opencode",
        });
        const committed = yield* store.commitTurn(created, {
          harness: "opencode",
          prompt: "old prompt",
          response: "old response",
          sessionId: "old-session",
          bindingCreatedAt: created.createdAt,
        });
        const undone = yield* store.undoLastTurn(committed.thread, "opencode");
        expect(yield* store.canRedoLastTurn(undone, "opencode")).toBe(true);

        const adopted = yield* store.resetNativeContext(undone, {
          harness: "opencode",
          sessionId: "selected-session",
          turns: [],
        });
        expect(yield* store.canRedoLastTurn(adopted, "opencode")).toBe(false);
        const redoExit = yield* Effect.exit(store.redoLastTurn(adopted, "opencode"));
        expect(redoExit._tag).toBe("Failure");
        expect(yield* store.messages(created.id)).toEqual([]);
      }).pipe(Effect.provide(ThreadStore.layerFromRoot(directory))),
    );
  });

  it("skips malformed undo entries while retaining valid recovery state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const created = yield* store.create({
          title: "Tolerant undo state",
          cwd: process.cwd(),
          harness: "opencode",
        });
        const committed = yield* store.commitTurn(created, {
          harness: "opencode",
          prompt: "keep me",
          response: "keep this response",
          sessionId: "tolerant-session",
          bindingCreatedAt: created.createdAt,
        });
        const undone = yield* store.undoLastTurn(committed.thread, "opencode");
        const undoPath = join(directory, "threads", created.id, "undo-stack.json");
        const stored = Schema.decodeUnknownSync(StoredUndoFixture)(
          JSON.parse(yield* Effect.promise(() => readFile(undoPath, "utf8"))),
        );
        yield* Effect.promise(() =>
          writeFile(
            undoPath,
            `${JSON.stringify({ entries: [{ messages: "invalid" }, ...stored.entries] })}\n`,
          ),
        );

        expect(yield* store.canRedoLastTurn(undone, "opencode")).toBe(true);
        const redone = yield* store.redoLastTurn(undone, "opencode");
        expect(redone.lastSeq).toBe(2);
        expect((yield* store.messages(created.id)).map((message) => message.content)).toEqual([
          "keep me",
          "keep this response",
        ]);
      }).pipe(Effect.provide(ThreadStore.layerFromRoot(directory))),
    );
  });

  for (const boundary of undoRedoBoundaries) {
    it(`recovers an interrupted undo at the ${boundary} boundary`, async () => {
      const root = await mkdtemp(join(tmpdir(), "relay-undo-atomic-"));
      try {
        const before = await createTwoTurns(root);
        const exit = await interruptUndo(root, before.thread, boundary);
        expect(exit._tag).toBe("Failure");

        const recovered = await recover(root, before.thread.id);
        const expectPostOperation = boundary !== "before-journal";
        const expectedMessages = expectPostOperation
          ? before.messages.slice(0, -2)
          : before.messages;
        expect(recovered.thread.lastSeq).toBe(expectPostOperation ? 2 : 4);
        expect(recovered.canRedo).toBe(expectPostOperation);
        expect(recovered.messages).toEqual(expectedMessages);
        expectCanonicalIdentities(recovered.messages);
        expect(
          await Bun.file(
            join(root, "threads", before.thread.id, "undo-redo-transaction.json"),
          ).exists(),
        ).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it(`recovers an interrupted redo at the ${boundary} boundary without duplicates`, async () => {
      const root = await mkdtemp(join(tmpdir(), "relay-redo-atomic-"));
      try {
        const before = await createTwoTurns(root);
        const undone = await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            return yield* store.undoLastTurn(before.thread, "opencode");
          }).pipe(Effect.provide(ThreadStore.layerFromRoot(root))),
        );
        const exit = await interruptRedo(root, undone, boundary);
        expect(exit._tag).toBe("Failure");

        const recovered = await recover(root, before.thread.id);
        const expectPostOperation = boundary !== "before-journal";
        const expectedMessages = expectPostOperation
          ? before.messages
          : before.messages.slice(0, -2);
        expect(recovered.thread.lastSeq).toBe(expectPostOperation ? 4 : 2);
        expect(recovered.canRedo).toBe(!expectPostOperation);
        expect(recovered.messages).toEqual(expectedMessages);
        expectCanonicalIdentities(recovered.messages);
        expect(
          await Bun.file(
            join(root, "threads", before.thread.id, "undo-redo-transaction.json"),
          ).exists(),
        ).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
