import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { SettingsError } from "../errors.ts";
import { DEFAULT_SWITCH_KEY, parseSwitchKey, type SwitchKeyBinding } from "../switch-key.ts";
import { relayDataRoot } from "./data-root.ts";

export interface RelaySettings {
  readonly switchKey: SwitchKeyBinding;
}

export const relayConfigPath = () => `${relayDataRoot()}/config.json`;
const defaultSettings = (): RelaySettings => ({ switchKey: DEFAULT_SWITCH_KEY });
const StoredRelaySettings = Schema.Struct({
  version: Schema.optionalKey(Schema.Unknown),
  switchKey: Schema.optionalKey(Schema.Unknown),
});

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

const decodeRelaySettings = (value: unknown) =>
  Schema.decodeUnknownEffect(StoredRelaySettings)(value).pipe(
    Effect.mapError(() => new Error("expected a JSON object")),
    Effect.flatMap((stored) => {
      if (stored.version !== 1) {
        return Effect.fail(
          new Error(`unsupported settings version ${String(stored.version ?? "missing")}`),
        );
      }
      const switchKey = stored.switchKey;
      if (typeof switchKey !== "string") {
        return Effect.fail(new Error("switchKey must be a string"));
      }
      return Effect.try({
        try: () => ({ switchKey: parseSwitchKey(switchKey) }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
    }),
  );

const loadRelaySettings = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      await chmod(path, 0o600);
      const value: unknown = await file.json();
      return value;
    },
    catch: (cause) => settingsError("load", path, cause),
  }).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.succeed(defaultSettings())
        : decodeRelaySettings(value).pipe(
            Effect.mapError((cause) => invalidSettingsError(path, cause)),
          ),
    ),
  );

const saveRelaySettings = (operation: "save" | "reset", path: string, settings: RelaySettings) =>
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

export interface SettingsServiceInterface {
  readonly path: () => string;
  readonly load: () => Effect.Effect<RelaySettings, SettingsError>;
  readonly save: (settings: RelaySettings) => Effect.Effect<void, SettingsError>;
  readonly reset: () => Effect.Effect<void, SettingsError>;
}

const makeSettingsService = (path: string): SettingsServiceInterface => ({
  path: () => path,
  load: Effect.fn("SettingsService.load")(() => loadRelaySettings(path)),
  save: Effect.fn("SettingsService.save")((settings: RelaySettings) =>
    saveRelaySettings("save", path, settings),
  ),
  reset: Effect.fn("SettingsService.reset")(() =>
    saveRelaySettings("reset", path, defaultSettings()),
  ),
});

export class SettingsService extends Context.Service<SettingsService, SettingsServiceInterface>()(
  "@relay/SettingsService",
) {
  static readonly layer = Layer.sync(SettingsService, () =>
    SettingsService.of(makeSettingsService(relayConfigPath())),
  );

  static readonly layerAt = (path: string) =>
    Layer.succeed(SettingsService, SettingsService.of(makeSettingsService(path)));
}
