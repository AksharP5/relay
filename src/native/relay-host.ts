import type {
  Harness,
  NativeTranscript,
  NativeTranscriptTurn,
  RelayMessage,
  RelayThread,
} from "../domain.ts";
import { CodexNativeBackend } from "./codex-backend.ts";
import type { NativeRelayController } from "./controller.ts";
import { NativeSessionUnavailable } from "./errors.ts";
import { OpenCodeNativeBackend } from "./opencode-backend.ts";
import { runNativeTui, type NativeTuiCommand, type NativeTuiExit } from "./pty-host.ts";
import { selectHarness } from "./selector.ts";

export interface NativeBackend {
  readonly prepareSession: (input: {
    readonly sessionId?: string;
    readonly model?: string;
    readonly title: string;
    readonly handoff: ReadonlyArray<RelayMessage>;
    readonly handoffOmittedMessages: number;
  }) => Promise<{
    readonly sessionId?: string;
    readonly handoffInjected: boolean;
  }>;
  readonly inject: (
    sessionId: string,
    messages: ReadonlyArray<RelayMessage>,
    omittedMessages?: number,
  ) => Promise<void>;
  readonly read: (sessionId: string) => Promise<NativeTranscript>;
  readonly isMaterialized?: (sessionId: string) => Promise<boolean>;
  readonly isIdle: (sessionId: string) => Promise<boolean>;
  readonly resolveSession: (fallbackSessionId?: string) => Promise<string | undefined>;
  readonly command: (sessionId?: string, model?: string) => NativeTuiCommand;
  readonly close: () => Promise<void>;
}

const executableFor = (harness: Harness) => {
  const executable = Bun.which(harness);
  if (!executable)
    throw new Error(
      `${harness} was not found in PATH. Install its latest release, then run relay doctor.`,
    );
  return executable;
};

const startBackend = async (harness: Harness, cwd: string): Promise<NativeBackend> => {
  const executable = executableFor(harness);
  if (harness === "codex") {
    const backend = await CodexNativeBackend.start(executable, cwd);
    return {
      prepareSession: ({ sessionId, model, handoff, handoffOmittedMessages }) =>
        backend.prepareSession({
          ...(sessionId ? { sessionId } : {}),
          ...(model ? { model } : {}),
          handoff,
          handoffOmittedMessages,
        }),
      inject: (sessionId, messages, omittedMessages) =>
        backend.inject(sessionId, messages, omittedMessages),
      read: (sessionId) => backend.read(sessionId),
      isMaterialized: (sessionId) => backend.isMaterialized(sessionId),
      isIdle: (sessionId) => backend.isIdle(sessionId),
      resolveSession: (sessionId) => backend.resolveSession(sessionId),
      command: (sessionId, model) => backend.command(sessionId, model),
      close: () => backend.close(),
    };
  }

  const backend = await OpenCodeNativeBackend.start(executable, cwd);
  return {
    prepareSession: async ({ sessionId, title }) => ({
      sessionId: await backend.ensureSession({
        ...(sessionId ? { sessionId } : {}),
        title,
      }),
      handoffInjected: false,
    }),
    inject: (sessionId, messages, omittedMessages) =>
      backend.inject(sessionId, messages, omittedMessages),
    read: (sessionId) => backend.read(sessionId),
    isMaterialized: async () => true,
    isIdle: (sessionId) => backend.isIdle(sessionId),
    resolveSession: (sessionId) =>
      sessionId ? backend.resolveSession(sessionId) : Promise.resolve(undefined),
    command: (sessionId) => {
      if (!sessionId) throw new Error("OpenCode did not create a native session");
      return backend.command(sessionId);
    },
    close: () => backend.close(),
  };
};

export interface NativeRelayHostDependencies {
  readonly startBackend: (harness: Harness, cwd: string) => Promise<NativeBackend>;
  readonly runTui: (
    command: NativeTuiCommand,
    onSwitchRequest: () => Promise<boolean>,
  ) => Promise<NativeTuiExit>;
  readonly selectHarness: (current: Harness) => Promise<Harness | undefined>;
  readonly signalSource: EventEmitter;
}

const defaultDependencies: NativeRelayHostDependencies = {
  startBackend,
  runTui: (command, onSwitchRequest) =>
    runNativeTui(
      command,
      { input: process.stdin, output: process.stdout, resizeSource: process },
      { onSwitchRequest },
    ),
  selectHarness,
  signalSource: process,
};

const signalExitCode = (signal: "SIGHUP" | "SIGTERM" | "SIGQUIT") =>
  ({ SIGHUP: 129, SIGTERM: 143, SIGQUIT: 131 })[signal];

const messagesOutsideTranscript = (
  messages: ReadonlyArray<RelayMessage>,
  turns: ReadonlyArray<NativeTranscriptTurn>,
) => {
  const nativeIds = new Set(turns.map((turn) => turn.id));
  return messages.filter((message) => !message.nativeId || !nativeIds.has(message.nativeId));
};

const synchronize = async (input: {
  readonly controller: NativeRelayController;
  readonly backend: NativeBackend;
  readonly thread: RelayThread;
  readonly harness: Harness;
  readonly sessionId: string;
  readonly sessionChanged: boolean;
}) => {
  const { controller, backend, harness, sessionId } = input;
  const model = input.thread.bindings[harness]?.model ?? input.thread.preferredModels?.[harness];
  const transcript = await backend.read(sessionId);
  const turns = transcript.turns;

  if (input.sessionChanged) {
    await controller.bind({
      threadId: input.thread.id,
      harness,
      sessionId,
      lastSyncedSeq: 0,
      ...(turns.at(-1)?.id ? { nativeCursor: turns.at(-1)!.id } : {}),
      ...(model ? { model } : {}),
    });
  }

  const delta = await controller.delta(input.thread.id, harness);
  const messages = input.sessionChanged
    ? messagesOutsideTranscript(delta.messages, turns)
    : delta.messages;
  if (messages.length > 0) await backend.inject(sessionId, messages, delta.omittedMessages);

  let thread = await controller.bind({
    threadId: input.thread.id,
    harness,
    sessionId,
    lastSyncedSeq: delta.thread.lastSeq,
    ...(turns.at(-1)?.id ? { nativeCursor: turns.at(-1)!.id } : {}),
    ...(model ? { model } : {}),
  });

  thread = await controller.importTurns({
    threadId: input.thread.id,
    harness,
    sessionId,
    turns,
    hiddenTurnIds: transcript.hiddenTurnIds,
    ...(model ? { model } : {}),
  });
  return thread;
};

const runHarness = async (
  controller: NativeRelayController,
  initialThread: RelayThread,
  harness: Harness,
  dependencies: NativeRelayHostDependencies,
  getSignal: () => "SIGHUP" | "SIGTERM" | "SIGQUIT" | undefined,
): Promise<{ readonly thread: RelayThread; readonly exit: NativeTuiExit }> => {
  let thread = await controller.switchHarness(initialThread.id, harness);
  const backend = await dependencies.startBackend(harness, thread.cwd);
  try {
    const startupSignal = getSignal();
    if (startupSignal) return { thread, exit: { reason: "signal", signal: startupSignal } };
    let binding = thread.bindings[harness];
    let storedModel: string | undefined;
    let launchModel: string | undefined;
    let initialDelta: Awaited<ReturnType<NativeRelayController["delta"]>>;
    let prepared: Awaited<ReturnType<NativeBackend["prepareSession"]>>;
    let recoveredStaleBinding = false;

    while (true) {
      storedModel = binding?.model ?? thread.preferredModels?.[harness];
      // Once a native session exists, its own /model command owns the choice.
      // Passing Relay's last-known model on every resume would overwrite it.
      launchModel = binding ? undefined : storedModel;
      initialDelta = await controller.delta(thread.id, harness);
      try {
        prepared = await backend.prepareSession({
          ...(binding ? { sessionId: binding.sessionId } : {}),
          ...(launchModel ? { model: launchModel } : {}),
          title: thread.title,
          handoff: initialDelta.messages,
          handoffOmittedMessages: initialDelta.omittedMessages,
        });
        break;
      } catch (cause) {
        if (!(cause instanceof NativeSessionUnavailable) || !binding || recoveredStaleBinding)
          throw cause;
        recoveredStaleBinding = true;
        thread = await controller.dropBinding(thread.id, harness, binding.sessionId);
        binding = thread.bindings[harness];
      }
    }

    let sessionId = prepared.sessionId;
    if (sessionId) {
      if (prepared.handoffInjected) {
        thread = await controller.bind({
          threadId: thread.id,
          harness,
          sessionId,
          lastSyncedSeq: initialDelta.thread.lastSeq,
          ...(storedModel ? { model: storedModel } : {}),
        });
      }
      thread = await synchronize({
        controller,
        backend,
        thread,
        harness,
        sessionId,
        sessionChanged: !prepared.handoffInjected && (!binding || binding.sessionId !== sessionId),
      });
    }
    const preparedSignal = getSignal();
    if (preparedSignal) return { thread, exit: { reason: "signal", signal: preparedSignal } };
    const boundSessionId = thread.bindings[harness]?.sessionId;

    const exit = await dependencies.runTui(backend.command(sessionId, launchModel), async () => {
      sessionId = await backend.resolveSession(sessionId);
      return sessionId ? backend.isIdle(sessionId) : true;
    });

    const tuiSignal = exit.reason === "signal" ? exit.signal : getSignal();
    if (tuiSignal) return { thread, exit: { reason: "signal", signal: tuiSignal } };

    try {
      const resolvedSessionId = await backend.resolveSession(sessionId);
      if (resolvedSessionId) {
        const transcript = await backend.read(resolvedSessionId);
        const turns = transcript.turns;
        const materialized =
          turns.length > 0 || (await backend.isMaterialized?.(resolvedSessionId)) === true;
        if (boundSessionId || materialized) {
          thread = await synchronize({
            controller,
            backend,
            thread,
            harness,
            sessionId: resolvedSessionId,
            sessionChanged: resolvedSessionId !== boundSessionId,
          });
        }
      }
    } catch (cause) {
      if (!(cause instanceof NativeSessionUnavailable) || !boundSessionId) throw cause;
      thread = await controller.dropBinding(thread.id, harness, boundSessionId);
    }
    return { thread, exit };
  } finally {
    await backend.close();
  }
};

/** Runs exactly one upstream TUI at a time; Relay owns only switching and context transfer. */
export const launchNativeRelay = async (
  controller: NativeRelayController,
  overrides: Partial<NativeRelayHostDependencies> = {},
) => {
  const dependencies = { ...defaultDependencies, ...overrides };
  let pendingSignal: "SIGHUP" | "SIGTERM" | "SIGQUIT" | undefined;
  const onSignal = (signal: "SIGHUP" | "SIGTERM" | "SIGQUIT") => {
    pendingSignal ??= signal;
  };
  const onHangup = () => onSignal("SIGHUP");
  const onTerminate = () => onSignal("SIGTERM");
  const onQuit = () => onSignal("SIGQUIT");
  dependencies.signalSource.on("SIGHUP", onHangup);
  dependencies.signalSource.on("SIGTERM", onTerminate);
  dependencies.signalSource.on("SIGQUIT", onQuit);

  let lease: { readonly release: () => Promise<void> } | undefined;

  try {
    let thread = await controller.loadLocalThread();
    if (pendingSignal) {
      process.exitCode = signalExitCode(pendingSignal);
      return;
    }
    lease = await controller.acquireLease(thread.id);
    let harness = thread.activeHarness;
    while (true) {
      if (pendingSignal) {
        process.exitCode = signalExitCode(pendingSignal);
        return;
      }
      const result = await runHarness(
        controller,
        thread,
        harness,
        dependencies,
        () => pendingSignal,
      );
      thread = result.thread;
      if (result.exit.reason !== "switch") {
        if (result.exit.reason === "exit" && result.exit.exitCode !== 0)
          process.exitCode = result.exit.exitCode;
        if (result.exit.reason === "signal") process.exitCode = signalExitCode(result.exit.signal);
        return;
      }

      const selected = await dependencies.selectHarness(harness);
      if (!selected) {
        if (pendingSignal) process.exitCode = signalExitCode(pendingSignal);
        return;
      }
      harness = selected;
    }
  } finally {
    await lease?.release();
    dependencies.signalSource.off("SIGHUP", onHangup);
    dependencies.signalSource.off("SIGTERM", onTerminate);
    dependencies.signalSource.off("SIGQUIT", onQuit);
  }
};
import type { EventEmitter } from "node:events";
