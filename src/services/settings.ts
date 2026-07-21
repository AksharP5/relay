import { Context, Effect, Layer, Option, Schema } from "effect";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SettingsError } from "../errors.ts";
import { DEFAULT_SWITCH_KEY, parseSwitchKey, type SwitchKeyBinding } from "../switch-key.ts";
import { RelayPaths, type RelayPathsShape } from "./data-root.ts";

export interface RelaySettings {
  readonly switchKey: SwitchKeyBinding;
}

export const relayConfigPath = (paths: RelayPathsShape) => `${paths.root}/config.json`;
const defaultSettings = (): RelaySettings => ({ switchKey: DEFAULT_SWITCH_KEY });
const StoredRelaySettings = Schema.Struct({
  version: Schema.Literal(1),
  switchKey: Schema.String,
});
const StoredSettingsVersion = Schema.Struct({ version: Schema.Number });

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const settingsError = (operation: "load" | "save" | "reset", path: string, cause: unknown) =>
  new SettingsError({
    operation,
    path,
    message: `Relay settings at ${path} could not be ${operation === "load" ? "loaded" : operation === "save" ? "saved" : "reset"}: ${errorMessage(cause)}`,
    cause,
  });

const invalidSettingsError = (path: string, cause: unknown) =>
  new SettingsError({
    operation: "load",
    path,
    message: `Relay settings at ${path} are invalid: ${errorMessage(cause)}`,
    cause,
  });

const secureDirectory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

const settingsSchemaError = (value: unknown, cause: Schema.SchemaError) => {
  const version = Schema.decodeUnknownOption(StoredSettingsVersion)(value);
  return Option.isSome(version) && version.value.version !== 1
    ? new Error(`unsupported settings version ${version.value.version}`)
    : cause;
};

const decodeRelaySettings = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredRelaySettings)(value).pipe(
    Effect.mapError((cause) => settingsSchemaError(value, cause)),
    Effect.flatMap((stored) =>
      Effect.try({
        try: () => ({ switchKey: parseSwitchKey(stored.switchKey) }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    ),
  );

const isMissingFile = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const decodeSettingsSource = (path: string, source: string) =>
  Effect.try({
    try: () => {
      const value: unknown = JSON.parse(source);
      return value;
    },
    catch: (cause) => invalidSettingsError(path, cause),
  }).pipe(
    Effect.flatMap((value) =>
      decodeRelaySettings(value).pipe(
        Effect.mapError((cause) => invalidSettingsError(path, cause)),
      ),
    ),
  );

const loadRelaySettingsAt = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const source = await readFile(path, "utf8");
        await chmod(path, 0o600);
        return source;
      } catch (cause) {
        if (isMissingFile(cause)) return undefined;
        throw cause;
      }
    },
    catch: (cause) => settingsError("load", path, cause),
  }).pipe(
    Effect.flatMap((source) =>
      source === undefined ? Effect.succeed(defaultSettings()) : decodeSettingsSource(path, source),
    ),
  );

const saveRelaySettingsAt = (operation: "save" | "reset", path: string, settings: RelaySettings) =>
  Effect.tryPromise({
    try: async () => {
      await secureDirectory(dirname(path));
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(
        temp,
        `${JSON.stringify({ version: 1, switchKey: settings.switchKey.label }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temp, path);
      await chmod(path, 0o600);
    },
    catch: (cause) => settingsError(operation, path, cause),
  });

export const loadRelaySettings = (paths: RelayPathsShape) =>
  Effect.runPromise(loadRelaySettingsAt(relayConfigPath(paths)));

export const saveRelaySettings = (paths: RelayPathsShape, settings: RelaySettings) =>
  Effect.runPromise(saveRelaySettingsAt("save", relayConfigPath(paths), settings));

export const resetRelaySettings = (paths: RelayPathsShape) =>
  Effect.runPromise(saveRelaySettingsAt("reset", relayConfigPath(paths), defaultSettings()));

export interface SettingsServiceInterface {
  readonly path: () => string;
  readonly load: () => Effect.Effect<RelaySettings, SettingsError>;
  readonly save: (settings: RelaySettings) => Effect.Effect<void, SettingsError>;
  readonly reset: () => Effect.Effect<void, SettingsError>;
}

const makeSettingsService = (path: string): SettingsServiceInterface => ({
  path: () => path,
  load: Effect.fn("SettingsService.load")(() => loadRelaySettingsAt(path)),
  save: Effect.fn("SettingsService.save")((settings: RelaySettings) =>
    saveRelaySettingsAt("save", path, settings),
  ),
  reset: Effect.fn("SettingsService.reset")(() =>
    saveRelaySettingsAt("reset", path, defaultSettings()),
  ),
});

export class SettingsService extends Context.Service<SettingsService, SettingsServiceInterface>()(
  "@relay/SettingsService",
) {
  static readonly configuredLayer = Layer.effect(
    SettingsService,
    Effect.gen(function* () {
      const paths = yield* RelayPaths;
      return SettingsService.of(makeSettingsService(relayConfigPath(paths)));
    }),
  );

  static readonly layer = SettingsService.configuredLayer.pipe(Layer.provide(RelayPaths.layer));

  static readonly layerFromRoot = (root: string) =>
    SettingsService.configuredLayer.pipe(Layer.provide(RelayPaths.layerFromRoot(root)));

  static readonly layerAt = (path: string) =>
    Layer.succeed(SettingsService, SettingsService.of(makeSettingsService(path)));
}
