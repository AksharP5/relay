import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";
import { SettingsError } from "../errors.ts";
import { DEFAULT_SWITCH_KEY, parseSwitchKey, type SwitchKeyBinding } from "../switch-key.ts";
import { relayDataRoot } from "./data-root.ts";

export interface RelaySettings {
  readonly switchKey: SwitchKeyBinding;
}

export const relayConfigPath = () => `${relayDataRoot()}/config.json`;
const defaultSettings = (): RelaySettings => ({ switchKey: DEFAULT_SWITCH_KEY });

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const settingsError = (operation: "load" | "save" | "reset", path: string, cause: unknown) =>
  new SettingsError({
    operation,
    path,
    message:
      operation === "load"
        ? `Relay settings at ${path} are invalid: ${errorMessage(cause).replace(/^invalid settings: /, "")}`
        : `Relay settings at ${path} could not be ${operation === "save" ? "saved" : "reset"}: ${errorMessage(cause)}`,
    cause,
  });

const secureDirectory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

const loadRelaySettings = async (): Promise<RelaySettings> => {
  const path = relayConfigPath();
  const file = Bun.file(path);
  if (!(await file.exists())) return defaultSettings();

  try {
    await chmod(path, 0o600);
    const value: unknown = await file.json();
    if (!value || typeof value !== "object") throw new Error("expected a JSON object");
    const stored = value as { version?: unknown; switchKey?: unknown };
    if (stored.version !== 1) {
      throw new Error(`unsupported settings version ${String(stored.version ?? "missing")}`);
    }
    if (typeof stored.switchKey !== "string") throw new Error("switchKey must be a string");
    return { switchKey: parseSwitchKey(stored.switchKey) };
  } catch (cause) {
    throw new Error(`invalid settings: ${errorMessage(cause)}`);
  }
};

const saveRelaySettings = async (settings: RelaySettings) => {
  const path = relayConfigPath();
  await secureDirectory(dirname(path));
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(
    temp,
    `${JSON.stringify({ version: 1, switchKey: settings.switchKey.label }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temp, path);
  await chmod(path, 0o600);
};

export class SettingsService extends Context.Service<
  SettingsService,
  {
    readonly path: () => string;
    readonly load: () => Effect.Effect<RelaySettings, SettingsError>;
    readonly save: (settings: RelaySettings) => Effect.Effect<void, SettingsError>;
    readonly reset: () => Effect.Effect<void, SettingsError>;
  }
>()("@relay/SettingsService") {
  static readonly layer = Layer.succeed(SettingsService, {
    path: relayConfigPath,
    load: Effect.fn("SettingsService.load")(() => {
      const path = relayConfigPath();
      return Effect.tryPromise({
        try: loadRelaySettings,
        catch: (cause) => settingsError("load", path, cause),
      });
    }),
    save: Effect.fn("SettingsService.save")((settings: RelaySettings) => {
      const path = relayConfigPath();
      return Effect.tryPromise({
        try: () => saveRelaySettings(settings),
        catch: (cause) => settingsError("save", path, cause),
      });
    }),
    reset: Effect.fn("SettingsService.reset")(() => {
      const path = relayConfigPath();
      return Effect.tryPromise({
        try: () => saveRelaySettings(defaultSettings()),
        catch: (cause) => settingsError("reset", path, cause),
      });
    }),
  });
}
