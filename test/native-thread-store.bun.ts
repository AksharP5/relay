import { afterAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
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
});
