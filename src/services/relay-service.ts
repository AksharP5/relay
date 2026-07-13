import { Context, Effect, Layer } from "effect";
import { resolve } from "node:path";
import type {
  Harness,
  HarnessCapabilities,
  HarnessBinding,
  HarnessTurnProgress,
  NativeTranscriptTurn,
  RelayPreferences,
  RelayMessage,
  RelayThread,
  Skin,
  CommandImplementation,
} from "../domain.ts";
import { CliError, ThreadNotFound } from "../errors.ts";
import { HarnessService, type HarnessStatus } from "../harnesses/harness-service.ts";
import { ThreadStore } from "./thread-store.ts";
import { PreferenceStore } from "./preference-store.ts";

export interface AskInput {
  readonly prompt: string;
  readonly threadId?: string;
  readonly harness?: Harness;
  readonly model?: string;
  readonly command?: string;
  readonly onProgress?: (progress: HarnessTurnProgress) => void;
}

export interface AskResult {
  readonly thread: RelayThread;
  readonly response: RelayMessage;
  readonly createdBinding: boolean;
  readonly handedOffMessages: number;
}

export interface NativeDelta {
  readonly thread: RelayThread;
  readonly binding?: HarnessBinding;
  readonly messages: ReadonlyArray<RelayMessage>;
  readonly omittedMessages: number;
}

export const titleFromPrompt = (prompt: string) => {
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
    readonly switchHarness: (
      harness: Harness,
      threadId?: string,
    ) => Effect.Effect<RelayThread, unknown>;
    readonly useThread: (threadId: string) => Effect.Effect<RelayThread, unknown>;
    readonly current: () => Effect.Effect<RelayThread, unknown>;
    readonly list: () => Effect.Effect<ReadonlyArray<RelayThread>, unknown>;
    readonly history: () => Effect.Effect<ReadonlyArray<RelayMessage>, unknown>;
    readonly historyFor: (threadId: string) => Effect.Effect<ReadonlyArray<RelayMessage>, unknown>;
    readonly historyForDisplay: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<RelayMessage>, unknown>;
    readonly doctor: () => Effect.Effect<ReadonlyArray<HarnessStatus>>;
    readonly capabilities: (
      harness: Harness,
      cwd?: string,
    ) => Effect.Effect<HarnessCapabilities, unknown>;
    readonly preferences: () => Effect.Effect<RelayPreferences, unknown>;
    readonly setSkin: (skin: Skin) => Effect.Effect<RelayPreferences, unknown>;
    readonly setSwitchSkinWithHarness: (
      enabled: boolean,
    ) => Effect.Effect<RelayPreferences, unknown>;
    readonly setCommandImplementation: (
      action: string,
      implementation?: CommandImplementation,
    ) => Effect.Effect<RelayPreferences, unknown>;
    readonly control: (input: {
      readonly action: "compact" | "share" | "unshare" | "undo" | "redo";
      readonly harness?: Harness;
      readonly threadId?: string;
    }) => Effect.Effect<{ readonly thread: RelayThread; readonly message: string }, unknown>;
    readonly nativeDelta: (
      threadId: string,
      harness: Harness,
    ) => Effect.Effect<NativeDelta, unknown>;
    readonly bindNativeSession: (input: {
      readonly threadId: string;
      readonly harness: Harness;
      readonly sessionId: string;
      readonly lastSyncedSeq: number;
      readonly nativeCursor?: string;
      readonly model?: string;
    }) => Effect.Effect<RelayThread, unknown>;
    readonly importNativeTurns: (input: {
      readonly threadId: string;
      readonly harness: Harness;
      readonly sessionId: string;
      readonly turns: ReadonlyArray<NativeTranscriptTurn>;
      readonly model?: string;
    }) => Effect.Effect<RelayThread, unknown>;
    readonly dataRoot: string;
  }
>()("@relay/RelayService") {
  static readonly layer = Layer.effect(
    RelayService,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const harnesses = yield* HarnessService;
      const preferences = yield* PreferenceStore;

      const newThread = Effect.fn("RelayService.newThread")(
        (input: { readonly title: string; readonly cwd: string; readonly harness: Harness }) =>
          store.create(input),
      );

      const ensureCurrent = (input: AskInput) =>
        input.threadId
          ? store.get(input.threadId)
          : store.current().pipe(
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
            const binding = thread.bindings[harness];
            const model = input.model ?? binding?.model ?? thread.preferredModels?.[harness];
            const handoff = yield* store.messagesSince(thread.id, binding?.lastSyncedSeq ?? 0);

            const nativeResult = yield* harnesses
              .run(harness, {
                cwd: thread.cwd,
                prompt: input.prompt,
                handoff: handoff.messages,
                ...(handoff.omittedMessages
                  ? { handoffOmittedMessages: handoff.omittedMessages }
                  : {}),
                ...(binding ? { sessionId: binding.sessionId } : {}),
                ...(model ? { model } : {}),
                ...(input.command ? { command: input.command } : {}),
                ...(input.onProgress ? { onProgress: input.onProgress } : {}),
              })
              .pipe(
                Effect.catchTag("HarnessError", (error) =>
                  binding && error.sessionState === "uncertain"
                    ? store
                        .dropBinding(thread, harness)
                        .pipe(Effect.flatMap(() => Effect.fail(error)))
                    : Effect.fail(error),
                ),
              );

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
              handedOffMessages: handoff.messages.length,
            };
          }).pipe(Effect.ensuring(Effect.promise(lock.release)));
        }),
      );

      const switchHarness = Effect.fn("RelayService.switchHarness")(
        (harness: Harness, threadId?: string) =>
          Effect.gen(function* () {
            const current = yield* threadId ? store.get(threadId) : store.current();
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

      const historyFor = Effect.fn("RelayService.historyFor")((threadId: string) =>
        store.messages(threadId),
      );

      const historyForDisplay = Effect.fn("RelayService.historyForDisplay")((threadId: string) =>
        store.recentMessages(threadId, { maxMessages: 200, maxChars: 1_000_000 }),
      );

      const doctor = Effect.fn("RelayService.doctor")(() =>
        Effect.all([harnesses.status("codex"), harnesses.status("opencode")], { concurrency: 2 }),
      );

      const capabilities = Effect.fn("RelayService.capabilities")(
        (harness: Harness, cwd = process.cwd()) => harnesses.capabilities(harness, cwd),
      );

      const control = Effect.fn("RelayService.control")(
        (input: {
          readonly action: "compact" | "share" | "unshare" | "undo" | "redo";
          readonly harness?: Harness;
          readonly threadId?: string;
        }) =>
          Effect.gen(function* () {
            const thread = input.threadId
              ? yield* store.get(input.threadId)
              : yield* store.current();
            const lock = yield* store.acquireLock(thread.id);
            return yield* Effect.gen(function* () {
              const current = yield* store.get(thread.id);
              if (resolve(process.cwd()) !== resolve(current.cwd)) {
                return yield* new CliError({
                  message: `This task belongs to ${current.cwd}. Run Relay there before using native session controls.`,
                });
              }
              const harness = input.harness ?? current.activeHarness;
              const binding = current.bindings[harness];
              if (!binding) {
                return yield* new CliError({
                  message: `Run a ${harness} turn before using /${input.action}.`,
                });
              }
              if (input.action === "undo" && !(yield* store.canUndoLastTurn(current, harness))) {
                return yield* new CliError({
                  message: `/${input.action} is disabled because the latest Relay turn was not produced by ${harness}. Undoing the native session now could overwrite newer work from the other harness.`,
                });
              }
              if (input.action === "redo" && !(yield* store.canRedoLastTurn(current, harness))) {
                return yield* new CliError({
                  message: `There is no safe ${harness} turn to redo.`,
                });
              }
              const expectedPrompt =
                input.action === "undo"
                  ? (yield* store.messages(current.id)).at(-2)?.content
                  : undefined;
              const result = yield* harnesses.control(harness, {
                cwd: current.cwd,
                sessionId: binding.sessionId,
                action: input.action,
                ...(binding.model ? { model: binding.model } : {}),
                ...(expectedPrompt ? { expectedPrompt } : {}),
              });
              const updated =
                input.action === "undo"
                  ? yield* store.undoLastTurn(current, harness)
                  : input.action === "redo"
                    ? yield* store.redoLastTurn(current, harness)
                    : current;
              return { thread: updated, message: result.message };
            }).pipe(Effect.ensuring(Effect.promise(lock.release)));
          }),
      );

      const validateNativeCwd = (thread: RelayThread) =>
        resolve(process.cwd()) === resolve(thread.cwd)
          ? Effect.void
          : Effect.fail(
              new CliError({
                message: `This task belongs to ${thread.cwd}. Run Relay there, or select/create a task for ${process.cwd()}.`,
              }),
            );

      const nativeDelta = Effect.fn("RelayService.nativeDelta")(
        (threadId: string, harness: Harness) =>
          Effect.gen(function* () {
            const thread = yield* store.get(threadId);
            yield* validateNativeCwd(thread);
            const binding = thread.bindings[harness];
            const delta = yield* store.messagesSince(thread.id, binding?.lastSyncedSeq ?? 0);
            return { thread, ...(binding ? { binding } : {}), ...delta };
          }),
      );

      const bindNativeSession = Effect.fn("RelayService.bindNativeSession")(
        (input: {
          readonly threadId: string;
          readonly harness: Harness;
          readonly sessionId: string;
          readonly lastSyncedSeq: number;
          readonly nativeCursor?: string;
          readonly model?: string;
        }) =>
          Effect.gen(function* () {
            const lock = yield* store.acquireLock(input.threadId);
            return yield* Effect.gen(function* () {
              const thread = yield* store.get(input.threadId);
              yield* validateNativeCwd(thread);
              return yield* store.bindNativeSession(thread, input);
            }).pipe(Effect.ensuring(Effect.promise(lock.release)));
          }),
      );

      const importNativeTurns = Effect.fn("RelayService.importNativeTurns")(
        (input: {
          readonly threadId: string;
          readonly harness: Harness;
          readonly sessionId: string;
          readonly turns: ReadonlyArray<NativeTranscriptTurn>;
          readonly model?: string;
        }) =>
          Effect.gen(function* () {
            const lock = yield* store.acquireLock(input.threadId);
            return yield* Effect.gen(function* () {
              const thread = yield* store.get(input.threadId);
              yield* validateNativeCwd(thread);
              return yield* store.importNativeTurns(thread, input);
            }).pipe(Effect.ensuring(Effect.promise(lock.release)));
          }),
      );

      return {
        newThread,
        ask,
        switchHarness,
        useThread,
        current: store.current,
        list: store.list,
        history,
        historyFor,
        historyForDisplay,
        doctor,
        capabilities,
        preferences: preferences.load,
        setSkin: preferences.setSkin,
        setSwitchSkinWithHarness: preferences.setSwitchSkinWithHarness,
        setCommandImplementation: preferences.setCommandImplementation,
        control,
        nativeDelta,
        bindNativeSession,
        importNativeTurns,
        dataRoot: store.root,
      };
    }),
  );
}
