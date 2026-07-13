import { Effect, type ManagedRuntime } from "effect";
import { resolve } from "node:path";
import type {
  Harness,
  HarnessCapabilities,
  HarnessTurnProgress,
  CommandImplementation,
  RelayMessage,
  RelayPreferences,
  RelayThread,
  Skin,
} from "../domain.ts";
import { NoCurrentThread } from "../errors.ts";
import { RelayService, titleFromPrompt } from "../services/relay-service.ts";

export interface TuiSnapshot {
  readonly thread: RelayThread | null;
  readonly messages: ReadonlyArray<RelayMessage>;
  readonly harnesses: ReadonlyArray<{
    readonly harness: Harness;
    readonly installed: boolean;
    readonly healthy: boolean;
    readonly version?: string;
  }>;
  readonly capabilities: ReadonlyArray<HarnessCapabilities>;
  readonly preferences: RelayPreferences;
}

export interface TuiController {
  readonly load: () => Promise<TuiSnapshot>;
  readonly ask: (input: {
    readonly prompt: string;
    readonly harness: Harness;
    readonly model?: string;
    readonly command?: string;
    readonly onProgress?: (progress: HarnessTurnProgress) => void;
  }) => Promise<Pick<TuiSnapshot, "thread" | "messages">>;
  readonly switchHarness: (
    harness: Harness,
  ) => Promise<{ readonly thread: RelayThread; readonly preferences: RelayPreferences } | null>;
  readonly refreshCapabilities: (harness: Harness) => Promise<HarnessCapabilities>;
  readonly setSkin: (skin: Skin) => Promise<RelayPreferences>;
  readonly setSwitchSkinWithHarness: (enabled: boolean) => Promise<RelayPreferences>;
  readonly setCommandImplementation: (
    action: string,
    implementation?: CommandImplementation,
  ) => Promise<RelayPreferences>;
}

const isNoCurrentThread = (error: unknown): error is NoCurrentThread =>
  error instanceof NoCurrentThread;

const isCurrentDirectory = (thread: RelayThread) => resolve(thread.cwd) === resolve(process.cwd());

const selectDirectoryTask = (relay: typeof RelayService.Service) =>
  Effect.gen(function* () {
    const current = yield* relay.current().pipe(
      Effect.map((thread) => thread as RelayThread | null),
      Effect.catchIf(isNoCurrentThread, () => Effect.succeed(null)),
    );
    if (current && isCurrentDirectory(current)) return current;

    const match = (yield* relay.list()).find(isCurrentDirectory);
    if (!match) return null;
    return yield* relay.useThread(match.id);
  });

export const makeTuiController = (
  runtime: ManagedRuntime.ManagedRuntime<RelayService, unknown>,
): TuiController => {
  let activeThreadId: string | undefined;

  return {
    load: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          const thread = yield* selectDirectoryTask(relay);
          const activeHarness = thread?.activeHarness ?? "codex";
          const preferences = yield* relay.preferences();
          const skin = preferences.switchSkinWithHarness ? activeHarness : preferences.skin;
          const capabilityHarnesses = [...new Set([activeHarness, skin])];
          const [harnesses, capabilities] = yield* Effect.all(
            [
              relay.doctor(),
              Effect.all(
                capabilityHarnesses.map((harness) =>
                  relay
                    .capabilities(harness)
                    .pipe(Effect.orElseSucceed(() => ({ harness, models: [], commands: [] }))),
                ),
                { concurrency: 2 },
              ),
            ],
            { concurrency: 2 },
          );
          activeThreadId = thread?.id;
          const messages = thread ? yield* relay.historyForDisplay(thread.id) : [];
          return {
            thread,
            messages,
            harnesses,
            capabilities,
            preferences: { ...preferences, skin },
          };
        }),
      ),
    ask: (input) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          if (!activeThreadId) {
            const existing = yield* selectDirectoryTask(relay);
            const thread =
              existing ??
              (yield* relay.newThread({
                title: titleFromPrompt(input.prompt),
                cwd: process.cwd(),
                harness: input.harness,
              }));
            activeThreadId = thread.id;
          }
          const result = yield* relay.ask({ ...input, threadId: activeThreadId });
          const messages = yield* relay.historyForDisplay(result.thread.id);
          return { thread: result.thread, messages };
        }),
      ),
    switchHarness: (harness) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          if (!activeThreadId) activeThreadId = (yield* selectDirectoryTask(relay))?.id;
          if (!activeThreadId) return null;
          return yield* relay.switchHarness(harness, activeThreadId).pipe(
            Effect.flatMap((thread) =>
              relay.preferences().pipe(
                Effect.flatMap((preferences) =>
                  preferences.switchSkinWithHarness
                    ? relay.setSkin(harness).pipe(
                        Effect.map((next) => ({
                          thread: thread as RelayThread,
                          preferences: next,
                        })),
                      )
                    : Effect.succeed({ thread: thread as RelayThread, preferences }),
                ),
              ),
            ),
            Effect.catchIf(isNoCurrentThread, () => Effect.succeed(null)),
          );
        }),
      ),
    refreshCapabilities: (harness) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.capabilities(harness);
        }),
      ),
    setSkin: (skin) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          const preferences = yield* relay.setSkin(skin);
          return yield* relay
            .setSwitchSkinWithHarness(false)
            .pipe(Effect.map((next) => ({ ...next, skin: preferences.skin })));
        }),
      ),
    setSwitchSkinWithHarness: (enabled) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          const preferences = yield* relay.setSwitchSkinWithHarness(enabled);
          if (!enabled) return preferences;
          const thread = activeThreadId ? yield* relay.current() : null;
          return thread ? yield* relay.setSkin(thread.activeHarness) : preferences;
        }),
      ),
    setCommandImplementation: (action, implementation) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.setCommandImplementation(action, implementation);
        }),
      ),
  };
};
