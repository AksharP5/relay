import { Effect, type ManagedRuntime } from "effect";
import { resolve } from "node:path";
import type { Harness, HarnessTurnProgress, RelayMessage, RelayThread } from "../domain.ts";
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
}

export interface TuiController {
  readonly load: () => Promise<TuiSnapshot>;
  readonly ask: (input: {
    readonly prompt: string;
    readonly harness: Harness;
    readonly onProgress?: (progress: HarnessTurnProgress) => void;
  }) => Promise<Pick<TuiSnapshot, "thread" | "messages">>;
  readonly switchHarness: (harness: Harness) => Promise<RelayThread | null>;
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
): TuiController => ({
  load: () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const harnesses = yield* relay.doctor();
        const thread = yield* selectDirectoryTask(relay);
        const messages = thread ? yield* relay.historyForDisplay(thread.id) : [];
        return { thread, messages, harnesses };
      }),
    ),
  ask: (input) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const thread = yield* selectDirectoryTask(relay);
        if (!thread) {
          yield* relay.newThread({
            title: titleFromPrompt(input.prompt),
            cwd: process.cwd(),
            harness: input.harness,
          });
        }
        const result = yield* relay.ask(input);
        const messages = yield* relay.historyForDisplay(result.thread.id);
        return { thread: result.thread, messages };
      }),
    ),
  switchHarness: (harness) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const current = yield* selectDirectoryTask(relay);
        if (!current) return null;
        return yield* relay.switchHarness(harness).pipe(
          Effect.map((thread) => thread as RelayThread | null),
          Effect.catchIf(isNoCurrentThread, () => Effect.succeed(null)),
        );
      }),
    ),
});
