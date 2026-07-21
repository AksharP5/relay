import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";
import { DEFAULT_SWITCH_KEY, parseSwitchKey, type SwitchKeyBinding } from "../switch-key.ts";
import { relayDataRoot } from "./data-root.ts";

export interface RelaySettings {
  readonly switchKey: SwitchKeyBinding;
}

export const relayConfigPath = () => `${relayDataRoot()}/config.json`;
const defaultSettings = (): RelaySettings => ({ switchKey: DEFAULT_SWITCH_KEY });

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const SettingsHeader = Schema.Struct({ version: Schema.Unknown });
const StoredSettingsV1 = Schema.Struct({
  version: Schema.Literal(1),
  switchKey: Schema.String,
});

const secureDirectory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

export const loadRelaySettings = async (): Promise<RelaySettings> => {
  const path = relayConfigPath();
  const file = Bun.file(path);
  if (!(await file.exists())) return defaultSettings();

  try {
    await chmod(path, 0o600);
    const value: unknown = await file.json();
    const header = Schema.decodeUnknownSync(SettingsHeader)(value);
    if (header.version !== 1) {
      throw new Error(`unsupported settings version ${String(header.version ?? "missing")}`);
    }
    const stored = Schema.decodeUnknownSync(StoredSettingsV1)(value);
    return { switchKey: parseSwitchKey(stored.switchKey) };
  } catch (cause) {
    throw new Error(`Relay settings at ${path} are invalid: ${errorMessage(cause)}`);
  }
};

export const saveRelaySettings = async (settings: RelaySettings) => {
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

export const resetRelaySettings = () => saveRelaySettings(defaultSettings());
