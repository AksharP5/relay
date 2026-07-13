import { Context, Effect, Layer } from "effect";
import { resolve } from "node:path";
import type { Harness, HarnessTurnProgress, RelayMessage, RelayThread } from "../domain.ts";
import { CliError, ThreadNotFound } from "../errors.ts";
import { HarnessService, type HarnessStatus } from "../harnesses/harness-service.ts";
import { ThreadStore } from "./thread-store.ts";

export interface AskInput {
  readonly prompt: string;
  readonly harness?: Harness;
  readonly model?: string;
  readonly onProgress?: (progress: HarnessTurnProgress) => void;
}

export interface AskResult {
  readonly thread: RelayThread;
  readonly response: RelayMessage;
  readonly createdBinding: boolean;
  readonly handedOffMessages: number;
}

const titleFromPrompt = (prompt: string) => {
  const singleLine = prompt.replaceAll(/\s+/g, " ").trim();
  return singleLine.length <= 64 ? singleLine : `${singleLine.slice(0, 61)}...`;
};

export class RelayService extends Context.Service<
  RelayService,
  {
    readonly newThread: (input: {
      readonly title: string;
      readonly cwd: string;
      readonly harness: Harness;
    }) => Effect.Effect<RelayThread, unknown>;
    readonly ask: (input: AskInput) => Effect.Effect<AskResult, unknown>;
    readonly switchHarness: (harness: Harness) => Effect.Effect<RelayThread, unknown>;
    readonly useThread: (threadId: string) => Effect.Effect<RelayThread, unknown>;
    readonly current: () => Effect.Effect<RelayThread, unknown>;
    readonly list: () => Effect.Effect<ReadonlyArray<RelayThread>, unknown>;
    readonly history: () => Effect.Effect<ReadonlyArray<RelayMessage>, unknown>;
    readonly doctor: () => Effect.Effect<ReadonlyArray<HarnessStatus>>;
    readonly dataRoot: string;
  }
>()("@relay/RelayService") {
  static readonly layer = Layer.effect(
    RelayService,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const harnesses = yield* HarnessService;

      const newThread = Effect.fn("RelayService.newThread")(
        (input: { readonly title: string; readonly cwd: string; readonly harness: Harness }) =>
          store.create(input),
      );

      const ensureCurrent = (input: AskInput) =>
        store.current().pipe(
          Effect.catchTag("NoCurrentThread", () =>
            store.create({
              title: titleFromPrompt(input.prompt),
              cwd: process.cwd(),
              harness: input.harness ?? "codex",
            }),
          ),
        );

      const ask = Effect.fn("RelayService.ask")((input: AskInput) =>
        Effect.gen(function* () {
          const initialThread = yield* ensureCurrent(input);
          const lock = yield* store.acquireLock(initialThread.id);

          return yield* Effect.gen(function* () {
            const thread = yield* store.get(initialThread.id);
            if (resolve(process.cwd()) !== resolve(thread.cwd)) {
              return yield* new CliError({
                message: `This task belongs to ${thread.cwd}. Run Relay there, or select/create a task for ${process.cwd()}.`,
              });
            }

            const harness = input.harness ?? thread.activeHarness;
            const previousMessages = yield* store.messages(thread.id);
            const binding = thread.bindings[harness];
            const model = input.model ?? binding?.model;
            const handoff = previousMessages.filter(
              (message) => message.seq > (binding?.lastSyncedSeq ?? 0),
            );

            const nativeResult = yield* harnesses.run(harness, {
              cwd: thread.cwd,
              prompt: input.prompt,
              handoff,
              ...(binding ? { sessionId: binding.sessionId } : {}),
              ...(model ? { model } : {}),
              ...(input.onProgress ? { onProgress: input.onProgress } : {}),
            });

            const committed = yield* store.commitTurn(thread, {
              harness,
              prompt: input.prompt,
              response: nativeResult.text,
              sessionId: nativeResult.sessionId,
              bindingCreatedAt: binding?.createdAt ?? new Date().toISOString(),
              ...(model ? { model } : {}),
            });

            return {
              thread: committed.thread,
              response: committed.response,
              createdBinding: binding === undefined,
              handedOffMessages: handoff.length,
            };
          }).pipe(Effect.ensuring(Effect.promise(lock.release)));
        }),
      );

      const switchHarness = Effect.fn("RelayService.switchHarness")((harness: Harness) =>
        Effect.gen(function* () {
          const current = yield* store.current();
          const lock = yield* store.acquireLock(current.id);
          return yield* Effect.gen(function* () {
            const thread = yield* store.get(current.id);
            return yield* store.setHarness(thread, harness);
          }).pipe(Effect.ensuring(Effect.promise(lock.release)));
        }),
      );

      const useThread = Effect.fn("RelayService.useThread")((threadId: string) =>
        Effect.gen(function* () {
          const threads = yield* store.list();
          const matches = threads.filter(
            (thread) => thread.id === threadId || thread.id.startsWith(threadId),
          );
          if (matches.length === 0) {
            return yield* new ThreadNotFound({
              threadId,
              message: `Relay task ${threadId} was not found`,
            });
          }
          if (matches.length > 1) {
            return yield* new CliError({
              message: `Task id ${threadId} is ambiguous; provide more characters`,
            });
          }
          const thread = matches[0]!;
          yield* store.setCurrent(thread.id);
          return thread;
        }),
      );

      const history = Effect.fn("RelayService.history")(() =>
        Effect.gen(function* () {
          const thread = yield* store.current();
          return yield* store.messages(thread.id);
        }),
      );

      const doctor = Effect.fn("RelayService.doctor")(() =>
        Effect.all([harnesses.status("codex"), harnesses.status("opencode")], { concurrency: 2 }),
      );

      return {
        newThread,
        ask,
        switchHarness,
        useThread,
        current: store.current,
        list: store.list,
        history,
        doctor,
        dataRoot: store.root,
      };
    }),
  );
}
