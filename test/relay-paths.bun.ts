import { afterEach, describe, expect, it } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayPaths } from "../src/services/data-root.ts";
import { cleanupOrphanedProcesses } from "../src/services/process-registry.ts";
import { saveRelaySettings } from "../src/services/settings.ts";
import { ThreadStore } from "../src/services/thread-store.ts";
import { parseSwitchKey } from "../src/switch-key.ts";

const temporaryDirectories: Array<string> = [];

const temporaryDirectory = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const resolvePaths = (values: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* RelayPaths;
    }).pipe(
      Effect.provide(RelayPaths.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
    ),
  );

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RelayPaths", () => {
  it("uses the configured data directory", async () => {
    const paths = await resolvePaths({
      RELAY_DATA_DIR: "  /tmp/relay-configured  ",
      HOME: "/home/test",
    });
    expect(paths.root).toBe("/tmp/relay-configured");
  });

  it("derives the default data directory from HOME", async () => {
    const paths = await resolvePaths({ HOME: "/home/test" });
    expect(paths.root).toBe("/home/test/.local/share/relay");
  });

  it("keeps storage, settings, and process ownership on one captured root", async () => {
    const capturedRoot = await temporaryDirectory("relay-paths-captured-");
    const laterEnvironmentRoot = await temporaryDirectory("relay-paths-later-");
    const previousRoot = Bun.env.RELAY_DATA_DIR;
    const PathsLayer = RelayPaths.layer;
    const AppLayer = Layer.merge(
      PathsLayer,
      ThreadStore.configuredLayer.pipe(Layer.provide(PathsLayer)),
    );

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const paths = yield* RelayPaths;
          const store = yield* ThreadStore;
          expect(paths.root).toBe(capturedRoot);
          expect(store.root).toBe(capturedRoot);

          Bun.env.RELAY_DATA_DIR = laterEnvironmentRoot;
          yield* store.create({
            title: "Stable root regression",
            cwd: process.cwd(),
            harness: "codex",
          });
          yield* Effect.promise(() =>
            saveRelaySettings(paths, { switchKey: parseSwitchKey("Ctrl+G") }),
          );
          yield* Effect.promise(() => cleanupOrphanedProcesses(paths.root));
        }).pipe(
          Effect.provide(AppLayer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ RELAY_DATA_DIR: capturedRoot, HOME: "/unused" }),
            ),
          ),
        ),
      );

      expect(await Bun.file(join(capturedRoot, "index.json")).exists()).toBe(true);
      expect(await Bun.file(join(capturedRoot, "config.json")).exists()).toBe(true);
      expect((await stat(join(capturedRoot, "processes"))).isDirectory()).toBe(true);
      await expect(access(join(laterEnvironmentRoot, "index.json"))).rejects.toThrow();
      await expect(access(join(laterEnvironmentRoot, "config.json"))).rejects.toThrow();
      await expect(access(join(laterEnvironmentRoot, "processes"))).rejects.toThrow();
    } finally {
      if (previousRoot === undefined) delete Bun.env.RELAY_DATA_DIR;
      else Bun.env.RELAY_DATA_DIR = previousRoot;
    }
  });
});
