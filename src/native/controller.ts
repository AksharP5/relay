import { Effect, ManagedRuntime } from "effect";
import { resolve } from "node:path";

import type { Harness, NativeTranscriptTurn, RelayMessage, RelayThread } from "../domain.ts";
import { RelayService } from "../services/relay-service.ts";

export interface NativeRelayController {
  readonly loadLocalThread: (preferredHarness?: Harness) => Promise<RelayThread>;
  readonly acquireLease: (threadId: string) => Promise<{ readonly release: () => Promise<void> }>;
  readonly switchHarness: (threadId: string, harness: Harness) => Promise<RelayThread>;
  readonly delta: (
    threadId: string,
    harness: Harness,
  ) => Promise<{
    readonly thread: RelayThread;
    readonly messages: ReadonlyArray<RelayMessage>;
    readonly omittedMessages: number;
  }>;
  readonly bind: (input: {
    readonly threadId: string;
    readonly harness: Harness;
    readonly sessionId: string;
    readonly lastSyncedSeq: number;
    readonly nativeCursor?: string;
    readonly model?: string;
  }) => Promise<RelayThread>;
  readonly importTurns: (input: {
    readonly threadId: string;
    readonly harness: Harness;
    readonly sessionId: string;
    readonly turns: ReadonlyArray<NativeTranscriptTurn>;
    readonly hiddenTurnIds?: ReadonlyArray<string>;
    readonly model?: string;
  }) => Promise<RelayThread>;
  readonly dropBinding: (
    threadId: string,
    harness: Harness,
    expectedSessionId: string,
  ) => Promise<RelayThread>;
}

export const makeNativeRelayController = (
  runtime: ManagedRuntime.ManagedRuntime<RelayService, never>,
): NativeRelayController => {
  const run = <A>(effect: Effect.Effect<A, unknown, RelayService>) => runtime.runPromise(effect);

  return {
    loadLocalThread: (preferredHarness) =>
      run(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          const local = (yield* relay.list()).find(
            (thread) => resolve(thread.cwd) === resolve(process.cwd()),
          );
          if (local) return yield* relay.useThread(local.id);
          return yield* relay.newThread({
            title: "New Relay task",
            cwd: process.cwd(),
            harness: preferredHarness ?? "codex",
          });
        }),
      ),
    acquireLease: (threadId) =>
      run(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.acquireNativeLease(threadId);
        }),
      ),
    switchHarness: (threadId, harness) =>
      run(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.switchNativeHarness(threadId, harness);
        }),
      ),
    delta: (threadId, harness) =>
      run(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.nativeDelta(threadId, harness);
        }),
      ),
    bind: (input) =>
      run(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.bindNativeSession(input);
        }),
      ),
    importTurns: (input) =>
      run(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.importNativeTurns(input);
        }),
      ),
    dropBinding: (threadId, harness, expectedSessionId) =>
      run(
        Effect.gen(function* () {
          const relay = yield* RelayService;
          return yield* relay.dropNativeBinding(threadId, harness, expectedSessionId);
        }),
      ),
  };
};
