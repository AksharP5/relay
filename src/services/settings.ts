import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_SWITCH_KEY, parseSwitchKey, type SwitchKeyBinding } from "../switch-key.ts";
import type { RelayPathsShape } from "./data-root.ts";

export interface RelaySettings {
  readonly switchKey: SwitchKeyBinding;
}

export const relayConfigPath = (paths: RelayPathsShape) => `${paths.root}/config.json`;
const defaultSettings = (): RelaySettings => ({ switchKey: DEFAULT_SWITCH_KEY });

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const secureDirectory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

export const loadRelaySettings = async (paths: RelayPathsShape): Promise<RelaySettings> => {
  const path = relayConfigPath(paths);
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
    throw new Error(`Relay settings at ${path} are invalid: ${errorMessage(cause)}`);
  }
};

export const saveRelaySettings = async (paths: RelayPathsShape, settings: RelaySettings) => {
  const path = relayConfigPath(paths);
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

export const resetRelaySettings = (paths: RelayPathsShape) =>
  saveRelaySettings(paths, defaultSettings());
