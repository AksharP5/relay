import { Effect, type ManagedRuntime } from "effect";
import type { Harness, RelayMessage, RelayThread } from "../domain.ts";
import { NoCurrentThread } from "../errors.ts";
import { RelayService } from "../services/relay-service.ts";

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
  }) => Promise<Pick<TuiSnapshot, "thread" | "messages">>;
  readonly switchHarness: (harness: Harness) => Promise<RelayThread | null>;
}

const isNoCurrentThread = (error: unknown): error is NoCurrentThread =>
  error instanceof NoCurrentThread;

export const makeTuiController = (
  runtime: ManagedRuntime.ManagedRuntime<RelayService, unknown>,
): TuiController => ({
  load: () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const harnesses = yield* relay.doctor();
        const thread = yield* relay.current().pipe(
          Effect.map((current) => current as RelayThread | null),
          Effect.catchIf(isNoCurrentThread, () => Effect.succeed(null)),
        );
        const messages = thread ? yield* relay.history() : [];
        return { thread, messages, harnesses };
      }),
    ),
  ask: (input) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const result = yield* relay.ask(input);
        const messages = yield* relay.history();
        return { thread: result.thread, messages };
      }),
    ),
  switchHarness: (harness) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        return yield* relay.switchHarness(harness).pipe(
          Effect.map((thread) => thread as RelayThread | null),
          Effect.catchIf(isNoCurrentThread, () => Effect.succeed(null)),
        );
      }),
    ),
});
