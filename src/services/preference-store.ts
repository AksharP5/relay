import { Context, Effect, Layer } from "effect";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandImplementation, RelayPreferences, Skin } from "../domain.ts";
import { StoreError } from "../errors.ts";

const defaults: RelayPreferences = {
  skin: "codex",
  switchSkinWithHarness: true,
  commandImplementations: {},
};

const root = () => {
  const override = Bun.env.RELAY_DATA_DIR?.trim();
  if (override) return override;
  return Bun.env.HOME ? `${Bun.env.HOME}/.local/share/relay` : `${process.cwd()}/.relay`;
};

const path = () => `${root()}/preferences.json`;
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const normalize = (value: unknown): RelayPreferences => {
  if (!value || typeof value !== "object") return defaults;
  const input = value as Record<string, unknown>;
  const implementations: Record<string, CommandImplementation> = {};
  if (input.commandImplementations && typeof input.commandImplementations === "object") {
    for (const [key, implementation] of Object.entries(input.commandImplementations)) {
      if (
        implementation === "relay" ||
        implementation === "codex" ||
        implementation === "opencode"
      ) {
        implementations[key] = implementation;
      }
    }
  }
  return {
    skin: input.skin === "opencode" ? "opencode" : "codex",
    switchSkinWithHarness: input.switchSkinWithHarness !== false,
    commandImplementations: implementations,
  };
};

const read = async () => {
  const file = Bun.file(path());
  if (!(await file.exists())) return defaults;
  await chmod(path(), 0o600);
  return normalize(await file.json());
};

const write = async (preferences: RelayPreferences) => {
  const target = path();
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await chmod(dirname(target), 0o700);
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
};

export class PreferenceStore extends Context.Service<
  PreferenceStore,
  {
    readonly load: () => Effect.Effect<RelayPreferences, StoreError>;
    readonly setSkin: (skin: Skin) => Effect.Effect<RelayPreferences, StoreError>;
    readonly setSwitchSkinWithHarness: (
      enabled: boolean,
    ) => Effect.Effect<RelayPreferences, StoreError>;
    readonly setCommandImplementation: (
      action: string,
      implementation?: CommandImplementation,
    ) => Effect.Effect<RelayPreferences, StoreError>;
  }
>()("@relay/PreferenceStore") {
  static readonly layer = Layer.succeed(PreferenceStore, {
    load: Effect.fn("PreferenceStore.load")(() =>
      Effect.tryPromise({
        try: read,
        catch: (cause) =>
          new StoreError({ operation: "read preferences", message: errorMessage(cause), cause }),
      }),
    ),
    setSkin: Effect.fn("PreferenceStore.setSkin")((skin: Skin) =>
      Effect.tryPromise({
        try: async () => {
          const next = { ...(await read()), skin, switchSkinWithHarness: false };
          await write(next);
          return next;
        },
        catch: (cause) =>
          new StoreError({ operation: "write preferences", message: errorMessage(cause), cause }),
      }),
    ),
    setSwitchSkinWithHarness: Effect.fn("PreferenceStore.setSwitchSkinWithHarness")(
      (switchSkinWithHarness: boolean) =>
        Effect.tryPromise({
          try: async () => {
            const next = { ...(await read()), switchSkinWithHarness };
            await write(next);
            return next;
          },
          catch: (cause) =>
            new StoreError({ operation: "write preferences", message: errorMessage(cause), cause }),
        }),
    ),
    setCommandImplementation: Effect.fn("PreferenceStore.setCommandImplementation")(
      (action: string, implementation?: CommandImplementation) =>
        Effect.tryPromise({
          try: async () => {
            const current = await read();
            const commandImplementations = { ...current.commandImplementations };
            if (implementation) commandImplementations[action] = implementation;
            else delete commandImplementations[action];
            const next = { ...current, commandImplementations };
            await write(next);
            return next;
          },
          catch: (cause) =>
            new StoreError({ operation: "write preferences", message: errorMessage(cause), cause }),
        }),
    ),
  });
}
