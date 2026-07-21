import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsError } from "../src/errors.ts";
import { SettingsService } from "../src/services/settings.ts";
import { parseSwitchKey } from "../src/switch-key.ts";

let directory: string | undefined;

afterEach(async () => {
  delete Bun.env.RELAY_DATA_DIR;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const runSettings = <A, E>(
  use: (settings: typeof SettingsService.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* SettingsService);
    }).pipe(Effect.provide(SettingsService.layer)),
  );

describe("SettingsService", () => {
  it("owns load, save, reset, and the advertised config path", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-settings-service-"));
    Bun.env.RELAY_DATA_DIR = directory;

    await runSettings((settings) =>
      Effect.gen(function* () {
        expect(settings.path()).toBe(join(directory!, "config.json"));
        yield* settings.save({ switchKey: parseSwitchKey("ctrl+g") });
        expect((yield* settings.load()).switchKey.label).toBe("Ctrl+G");
        yield* settings.reset();
        expect((yield* settings.load()).switchKey.label).toBe("Ctrl+Q");
      }),
    );
  });

  it("reports malformed settings through the typed error channel", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-settings-invalid-"));
    Bun.env.RELAY_DATA_DIR = directory;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.json"), "null\n", "utf8");

    const failure = await runSettings((settings) => settings.load().pipe(Effect.flip));
    expect(failure).toBeInstanceOf(SettingsError);
    expect(failure).toMatchObject({
      _tag: "SettingsError",
      operation: "load",
      path: join(directory, "config.json"),
    });
    expect(failure.message).toContain("are invalid");
  });
});
