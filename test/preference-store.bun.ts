import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferenceStore } from "../src/services/preference-store.ts";

let directory: string | undefined;

const run = <A>(effect: Effect.Effect<A, unknown, PreferenceStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(PreferenceStore.layer)));

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  delete Bun.env.RELAY_DATA_DIR;
});

describe("Relay preferences", () => {
  it("persists independent skin, switching, and command behavior choices", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-preferences-"));
    Bun.env.RELAY_DATA_DIR = directory;

    await run(
      Effect.gen(function* () {
        const store = yield* PreferenceStore;
        expect(yield* store.load()).toEqual({
          skin: "codex",
          switchSkinWithHarness: true,
          commandImplementations: {},
        });
        yield* store.setSkin("opencode");
        yield* store.setSwitchSkinWithHarness(false);
        yield* store.setCommandImplementation("context.compact", "codex");
      }),
    );

    const persisted = await run(
      Effect.gen(function* () {
        const store = yield* PreferenceStore;
        return yield* store.load();
      }),
    );
    expect(persisted).toEqual({
      skin: "opencode",
      switchSkinWithHarness: false,
      commandImplementations: { "context.compact": "codex" },
    });
    expect((await Bun.file(`${directory}/preferences.json`).stat()).mode & 0o777).toBe(0o600);
  });
});
