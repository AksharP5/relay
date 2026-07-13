import { afterAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "relay-undo-"));
Bun.env.RELAY_DATA_DIR = directory;
const { ThreadStore } = await import("../src/services/thread-store.ts");

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  delete Bun.env.RELAY_DATA_DIR;
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
      }).pipe(Effect.provide(ThreadStore.layer)),
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
        });
        expect(yield* store.canRedoLastTurn(adopted, "opencode")).toBe(false);
        const redoExit = yield* Effect.exit(store.redoLastTurn(adopted, "opencode"));
        expect(redoExit._tag).toBe("Failure");
        expect(yield* store.messages(created.id)).toEqual([]);
      }).pipe(Effect.provide(ThreadStore.layer)),
    );
  });
});
