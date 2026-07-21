import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsError } from "../src/errors.ts";
import { SettingsService } from "../src/services/settings.ts";
import { parseSwitchKey } from "../src/switch-key.ts";

const directories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runSettings = <A, E>(
  path: string,
  use: (settings: typeof SettingsService.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* SettingsService);
    }).pipe(Effect.provide(SettingsService.layerAt(path))),
  );

const tempConfigPath = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return { directory, path: join(directory, "config.json") };
};

describe("SettingsService", () => {
  it("owns load, save, reset, and the advertised config path", async () => {
    const config = await tempConfigPath("relay-settings-service-");

    await runSettings(config.path, (settings) =>
      Effect.gen(function* () {
        expect(settings.path()).toBe(config.path);
        yield* settings.save({ switchKey: parseSwitchKey("ctrl+g") });
        expect((yield* settings.load()).switchKey.label).toBe("Ctrl+G");
        yield* settings.reset();
        expect((yield* settings.load()).switchKey.label).toBe("Ctrl+Q");
      }),
    );
  });

  it("reports malformed JSON and schema-invalid settings through the typed channel", async () => {
    const config = await tempConfigPath("relay-settings-invalid-");

    for (const source of ["{not-json\n", '{"version":1,"switchKey":42}\n']) {
      await writeFile(config.path, source, "utf8");
      const failure = await runSettings(config.path, (settings) =>
        settings.load().pipe(Effect.flip),
      );
      expect(failure).toBeInstanceOf(SettingsError);
      expect(failure).toMatchObject({
        _tag: "SettingsError",
        operation: "load",
        path: config.path,
      });
      expect(failure.message).toContain("are invalid");
    }
  });

  it("distinguishes load I/O failures from invalid settings", async () => {
    const path = "/dev/null/config.json";

    const failure = await runSettings(path, (settings) => settings.load().pipe(Effect.flip));
    expect(failure).toMatchObject({
      _tag: "SettingsError",
      operation: "load",
      path,
    });
    expect(failure.message).toContain("could not be loaded");
    expect(failure.message).not.toContain("are invalid");
  });

  it("reports save and reset failures with their exact operations", async () => {
    const config = await tempConfigPath("relay-settings-write-failure-");
    const blockingFile = join(config.directory, "not-a-directory");
    const blockedPath = join(blockingFile, "config.json");
    await writeFile(blockingFile, "blocked\n", "utf8");

    const saveFailure = await runSettings(blockedPath, (settings) =>
      settings.save({ switchKey: parseSwitchKey("ctrl+g") }).pipe(Effect.flip),
    );
    expect(saveFailure).toMatchObject({
      _tag: "SettingsError",
      operation: "save",
      path: blockedPath,
    });
    expect(saveFailure.message).toContain("could not be saved");

    const resetFailure = await runSettings(blockedPath, (settings) =>
      settings.reset().pipe(Effect.flip),
    );
    expect(resetFailure).toMatchObject({
      _tag: "SettingsError",
      operation: "reset",
      path: blockedPath,
    });
    expect(resetFailure.message).toContain("could not be reset");
  });
});
