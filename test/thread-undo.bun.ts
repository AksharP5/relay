import { afterAll, describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../src/services/thread-store.ts";

const directory = await mkdtemp(join(tmpdir(), "relay-undo-"));
const StoredUndoFixture = Schema.Struct({ entries: Schema.Array(Schema.Unknown) });

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

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
});
