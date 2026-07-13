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
  readonly listTasks: () => Promise<ReadonlyArray<RelayThread>>;
  readonly selectTask: (
    threadId: string,
  ) => Promise<Pick<TuiSnapshot, "thread" | "messages" | "preferences">>;
  readonly newTask: (harness: Harness) => Promise<RelayThread>;
  readonly control: (
    action: "compact" | "share" | "unshare" | "undo" | "redo",
    harness: Harness,
  ) => Promise<{
    readonly message: string;
    readonly thread: RelayThread;
    readonly messages: ReadonlyArray<RelayMessage>;
  }>;
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
              relay
                .preferences()
                .pipe(
                  Effect.map((preferences) => ({ thread: thread as RelayThread, preferences })),
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
    listTasks: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return (yield* relay.list()).filter(isCurrentDirectory);
        }),
      ),
    selectTask: (threadId) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          const thread = yield* relay.useThread(threadId);
          if (!isCurrentDirectory(thread)) {
            return yield* Effect.fail(new Error(`This task belongs to ${thread.cwd}`));
          }
          activeThreadId = thread.id;
          const messages = yield* relay.historyForDisplay(thread.id);
          const preferences = yield* relay.preferences();
          return { thread, messages, preferences };
        }),
      ),
    newTask: (harness) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          const thread = yield* relay.newThread({
            title: "New Relay task",
            cwd: process.cwd(),
            harness,
          });
          activeThreadId = thread.id;
          return thread;
        }),
      ),
    control: (action, harness) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          if (!activeThreadId) {
            return yield* new NoCurrentThread({
              message: "Run a turn in this directory before using a native session command.",
            });
          }
          const result = yield* relay.control({
            action,
            harness,
            threadId: activeThreadId,
          });
          const messages = yield* relay.historyForDisplay(result.thread.id);
          return { message: result.message, thread: result.thread, messages };
        }),
      ),
    setSkin: (skin) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.setSkin(skin);
        }),
      ),
    setSwitchSkinWithHarness: (enabled) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.setSwitchSkinWithHarness(enabled);
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
