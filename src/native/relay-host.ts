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
import {
  releaseNativeTuiInput,
  runNativeTui,
  type NativeParentSignal,
  type NativeTuiCommand,
  type NativeTuiExit,
} from "./pty-host.ts";

export interface NativeBackend {
  readonly preparesColdHandoff?: boolean;
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
  /** With no id, return whether detaching an unresolved native selection is safe. */
  readonly isIdle: (sessionId?: string) => Promise<boolean>;
  readonly resolveSession: (
    fallbackSessionId?: string,
    requireCurrentObservation?: boolean,
  ) => Promise<string | undefined>;
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

const stripTerminalControls = (value: string) =>
  value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");

export const openCodeSessionIdFromExit = (outputTail: string) => {
  const plain = stripTerminalControls(outputTail);
  const matches = [
    ...plain.matchAll(
      /(?:^|[\r\n])\s*Session[ \t]+[^\r\n]+[\r\n]+\s*Continue[ \t]+opencode[ \t]+-s[ \t]+(ses_[A-Za-z0-9]+)/g,
    ),
  ];
  return matches.at(-1)?.[1];
};

const startBackend = async (
  harness: Harness,
  cwd: string,
  signal?: AbortSignal,
): Promise<NativeBackend> => {
  const executable = executableFor(harness);
  if (harness === "codex") {
    const backend = await CodexNativeBackend.start(executable, cwd, signal);
    return {
      preparesColdHandoff: true,
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

  const backend = await OpenCodeNativeBackend.start(executable, cwd, signal);
  return {
    prepareSession: async ({ sessionId, title, handoff }) =>
      !sessionId && handoff.length === 0
        ? { handoffInjected: false }
        : {
            sessionId: await backend.ensureSession({
              ...(sessionId ? { sessionId } : {}),
              title,
            }),
            handoffInjected: false,
          },
    inject: (sessionId, messages, omittedMessages) =>
      backend.inject(sessionId, messages, omittedMessages),
    read: (sessionId) => backend.read(sessionId),
    isMaterialized: async () => true,
    isIdle: (sessionId) => backend.isIdle(sessionId),
    resolveSession: (sessionId, requireCurrentObservation) =>
      backend.resolveSession(sessionId, requireCurrentObservation),
    command: (sessionId) => backend.command(sessionId),
    close: () => backend.close(),
  };
};

export interface NativeRelayHostDependencies {
  readonly startBackend: (
    harness: Harness,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<NativeBackend>;
  readonly runTui: (
    command: NativeTuiCommand,
    onSwitchRequest: (recentSubmit?: boolean) => Promise<boolean>,
    coldLaunch: boolean,
    harness: Harness,
  ) => Promise<NativeTuiExit>;
  readonly signalSource: EventEmitter;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
}

const defaultDependencies: NativeRelayHostDependencies = {
  startBackend,
  runTui: (command, onSwitchRequest, coldLaunch, harness) =>
    runNativeTui(
      command,
      { input: process.stdin, output: process.stdout, resizeSource: process },
      {
        onSwitchRequest,
        submitGraceMs: coldLaunch ? 2_000 : 0,
        submitProtectionMs: 10_000,
        preserveInputOnSwitch: true,
        ...(harness === "opencode"
          ? { sessionIdHint: { extract: openCodeSessionIdFromExit } }
          : {}),
      },
    ),
  signalSource: process,
  wait: Bun.sleep,
  now: Date.now,
};

const signalExitCode = (signal: NativeParentSignal) =>
  ({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGQUIT: 131 })[signal];

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
  readonly transcript?: NativeTranscript;
}) => {
  const { controller, backend, harness, sessionId } = input;
  const model = input.thread.bindings[harness]?.model ?? input.thread.preferredModels?.[harness];
  const transcript = input.transcript ?? (await backend.read(sessionId));
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
  let thread = input.thread;
  if (messages.length > 0) {
    thread = await controller.beginHandoff({
      threadId: input.thread.id,
      harness,
      sessionId,
      fromSeq: delta.binding?.lastSyncedSeq ?? 0,
      throughSeq: delta.thread.lastSeq,
    });
    await backend.inject(sessionId, messages, delta.omittedMessages);
  }

  thread = await controller.bind({
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

const adoptNativeSession = async (input: {
  readonly controller: NativeRelayController;
  readonly thread: RelayThread;
  readonly harness: Harness;
  readonly sessionId: string;
  readonly transcript: NativeTranscript;
}) => {
  const { controller, harness, sessionId, transcript } = input;
  const model = input.thread.bindings[harness]?.model ?? input.thread.preferredModels?.[harness];
  const turns = transcript.turns;
  let thread = await controller.bind({
    threadId: input.thread.id,
    harness,
    sessionId,
    // Native navigation is an intentional context reset. Do not append the
    // prior canonical log behind turns already completed in the selected session.
    lastSyncedSeq: input.thread.lastSeq,
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
  getSignal: () => NativeParentSignal | undefined,
  subscribeSignal: (listener: (signal: NativeParentSignal) => void) => () => void,
  allowSwitchAttempt: () => boolean,
  armToggleLatch: boolean,
): Promise<{ readonly thread: RelayThread; readonly exit: NativeTuiExit }> => {
  let thread = await controller.switchHarness(initialThread.id, harness);
  if (thread.pendingHandoffs?.[harness]) {
    thread = await controller.abandonHandoff(thread.id, harness);
  }
  let backend: NativeBackend | undefined;
  let closingBackend: Promise<void> | undefined;
  const closeBackend = () => {
    if (!backend) return Promise.resolve();
    closingBackend ??= backend.close();
    return closingBackend;
  };
  let startupSignal: NativeParentSignal | undefined;
  const startupAbort = new AbortController();
  let resolveSignal: (signal: NativeParentSignal) => void;
  const signalReceived = new Promise<NativeParentSignal>((resolve) => (resolveSignal = resolve));
  const unsubscribeSignal = subscribeSignal((signal) => {
    startupSignal ??= signal;
    resolveSignal(signal);
    startupAbort.abort(signal);
    if (backend) void closeBackend().catch(() => undefined);
  });
  const startingBackend = dependencies.startBackend(harness, thread.cwd, startupAbort.signal);
  let started: { readonly backend: NativeBackend } | { readonly signal: NativeParentSignal };
  try {
    started = await Promise.race([
      startingBackend.then((value) => ({ backend: value }) as const),
      signalReceived.then((signal) => ({ signal }) as const),
    ]);
  } catch (cause) {
    unsubscribeSignal();
    if (startupSignal) return { thread, exit: { reason: "signal", signal: startupSignal } };
    throw cause;
  }
  if ("signal" in started) {
    void startingBackend.then((lateBackend) => lateBackend.close()).catch(() => undefined);
    unsubscribeSignal();
    return { thread, exit: { reason: "signal", signal: started.signal } };
  }
  backend = started.backend;
  try {
    const signalAfterStartup = startupSignal ?? getSignal();
    if (signalAfterStartup)
      return { thread, exit: { reason: "signal", signal: signalAfterStartup } };
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
      if (!binding && initialDelta.messages.length > 0 && backend.preparesColdHandoff) {
        thread = await controller.beginHandoff({
          threadId: thread.id,
          harness,
          fromSeq: 0,
          throughSeq: initialDelta.thread.lastSeq,
        });
      }
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
    const launchSessionId = sessionId;
    const coldLaunch = sessionId === undefined;
    if (armToggleLatch) allowSwitchAttempt();

    const exit = await dependencies.runTui(
      backend.command(sessionId, launchModel),
      async (recentSubmit = false) => {
        if (!allowSwitchAttempt()) return false;

        // A native TUI forwards Enter before Relay sees the switch key. Sample
        // the backend across a short settling window so a newly-starting turn
        // cannot be mistaken for an idle session and terminated mid-request.
        try {
          for (let sample = 0; sample < 3; sample += 1) {
            await dependencies.wait(80);
            sessionId = await backend.resolveSession(sessionId, true);
            const sessionBecameCold =
              launchSessionId === undefined || sessionId !== launchSessionId;
            if (recentSubmit && sessionBecameCold && !sessionId && harness === "codex")
              return false;
            if (
              recentSubmit &&
              sessionBecameCold &&
              sessionId &&
              backend.isMaterialized &&
              !(await backend.isMaterialized(sessionId))
            )
              return false;
            if (!(await backend.isIdle(sessionId))) return false;
          }
        } catch {
          // Losing native session visibility is not permission to detach it.
          return false;
        }
        return true;
      },
      coldLaunch,
      harness,
    );

    const tuiSignal = exit.reason === "signal" ? exit.signal : getSignal();
    if (tuiSignal) return { thread, exit: { reason: "signal", signal: tuiSignal } };

    try {
      const resolvedSessionId = exit.sessionIdHint ?? (await backend.resolveSession(sessionId));
      if (resolvedSessionId) {
        const transcript = await backend.read(resolvedSessionId);
        const turns = transcript.turns;
        const materialized =
          turns.length > 0 || (await backend.isMaterialized?.(resolvedSessionId)) === true;
        if (resolvedSessionId === boundSessionId || materialized) {
          thread =
            resolvedSessionId === boundSessionId
              ? await synchronize({
                  controller,
                  backend,
                  thread,
                  harness,
                  sessionId: resolvedSessionId,
                  sessionChanged: false,
                  transcript,
                })
              : await adoptNativeSession({
                  controller,
                  thread,
                  harness,
                  sessionId: resolvedSessionId,
                  transcript,
                });
        }
      }
    } catch (cause) {
      if (!(cause instanceof NativeSessionUnavailable) || !boundSessionId) throw cause;
      thread = await controller.dropBinding(thread.id, harness, boundSessionId);
    }
    return { thread, exit };
  } catch (cause) {
    const signal = startupSignal ?? getSignal();
    if (signal) return { thread, exit: { reason: "signal", signal } };
    throw cause;
  } finally {
    unsubscribeSignal();
    await closeBackend();
  }
};

/** Runs exactly one upstream TUI at a time; Relay owns only switching and context transfer. */
export const launchNativeRelay = async (
  controller: NativeRelayController,
  overrides: Partial<NativeRelayHostDependencies> = {},
) => {
  const dependencies = { ...defaultDependencies, ...overrides };
  let pendingSignal: NativeParentSignal | undefined;
  const signalSubscribers = new Set<(signal: NativeParentSignal) => void>();
  const onSignal = (signal: NativeParentSignal) => {
    if (pendingSignal) return;
    pendingSignal = signal;
    for (const subscriber of signalSubscribers) subscriber(signal);
    signalSubscribers.clear();
  };
  const subscribeSignal = (listener: (signal: NativeParentSignal) => void) => {
    if (pendingSignal) {
      queueMicrotask(() => listener(pendingSignal!));
      return () => undefined;
    }
    signalSubscribers.add(listener);
    return () => signalSubscribers.delete(listener);
  };
  const onHangup = () => onSignal("SIGHUP");
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");
  const onQuit = () => onSignal("SIGQUIT");
  dependencies.signalSource.on("SIGHUP", onHangup);
  dependencies.signalSource.on("SIGINT", onInterrupt);
  dependencies.signalSource.on("SIGTERM", onTerminate);
  dependencies.signalSource.on("SIGQUIT", onQuit);

  let lease: { readonly release: () => Promise<void> } | undefined;
  let lastToggleAttemptAt: number | undefined;
  const allowSwitchAttempt = () => {
    const now = dependencies.now();
    const allowed = lastToggleAttemptAt === undefined || now - lastToggleAttemptAt >= 1_000;
    // Refresh on every repeat so a held legacy key remains latched until it has
    // been released for one full second, including across harness processes.
    lastToggleAttemptAt = now;
    return allowed;
  };

  try {
    let thread = await controller.loadLocalThread();
    if (pendingSignal) {
      process.exitCode = signalExitCode(pendingSignal);
      return;
    }
    const acquired = await controller.acquireLease(thread.id);
    lease = acquired;
    thread = acquired.thread;
    let harness = thread.activeHarness;
    let armToggleLatch = false;
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
        subscribeSignal,
        allowSwitchAttempt,
        armToggleLatch,
      );
      thread = result.thread;
      if (result.exit.reason !== "switch") {
        if (result.exit.reason === "exit" && result.exit.exitCode !== 0)
          process.exitCode = result.exit.exitCode;
        if (result.exit.reason === "signal") process.exitCode = signalExitCode(result.exit.signal);
        return;
      }

      armToggleLatch = true;
      harness = harness === "codex" ? "opencode" : "codex";
    }
  } finally {
    await releaseNativeTuiInput();
    await lease?.release();
    dependencies.signalSource.off("SIGHUP", onHangup);
    dependencies.signalSource.off("SIGINT", onInterrupt);
    dependencies.signalSource.off("SIGTERM", onTerminate);
    dependencies.signalSource.off("SIGQUIT", onQuit);
  }
};
import type { EventEmitter } from "node:events";
