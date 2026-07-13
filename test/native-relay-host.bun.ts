import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";

import type { Harness, NativeTranscriptTurn, RelayMessage, RelayThread } from "../src/domain.ts";
import type { NativeRelayController } from "../src/native/controller.ts";
import { NativeSessionUnavailable } from "../src/native/errors.ts";
import {
  launchNativeRelay,
  openCodeSessionIdFromExit,
  type NativeBackend,
} from "../src/native/relay-host.ts";

const now = "2026-07-13T00:00:00.000Z";

const makeController = () => {
  let thread: RelayThread = {
    id: "relay-thread",
    title: "New Relay task",
    cwd: process.cwd(),
    activeHarness: "codex",
    bindings: {},
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  const messages: Array<RelayMessage> = [];

  const controller: NativeRelayController = {
    loadLocalThread: async () => thread,
    acquireLease: async () => ({ thread, release: async () => {} }),
    switchHarness: async (_threadId, harness) => {
      thread = { ...thread, activeHarness: harness };
      return thread;
    },
    delta: async (_threadId, harness) => {
      const after = thread.bindings[harness]?.lastSyncedSeq ?? 0;
      return {
        thread,
        ...(thread.bindings[harness] ? { binding: thread.bindings[harness] } : {}),
        messages: messages.filter((message) => message.seq > after),
        omittedMessages: 0,
      };
    },
    bind: async (input) => {
      const existing = thread.bindings[input.harness];
      const binding = {
        harness: input.harness,
        sessionId: input.sessionId,
        lastSyncedSeq: input.lastSyncedSeq,
        ...(input.nativeCursor ? { nativeCursor: input.nativeCursor } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      thread = {
        ...thread,
        activeHarness: input.harness,
        bindings: { ...thread.bindings, [input.harness]: binding },
        pendingHandoffs: {
          ...thread.pendingHandoffs,
          [input.harness]: undefined,
        },
      };
      return thread;
    },
    beginHandoff: async (input) => {
      thread = {
        ...thread,
        pendingHandoffs: {
          ...thread.pendingHandoffs,
          [input.harness]: {
            id: `pending-${input.harness}`,
            harness: input.harness,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            fromSeq: input.fromSeq,
            throughSeq: input.throughSeq,
            createdAt: now,
          },
        },
      };
      return thread;
    },
    abandonHandoff: async (_threadId, harness) => {
      const bindings = { ...thread.bindings };
      delete bindings[harness];
      thread = {
        ...thread,
        bindings,
        pendingHandoffs: { ...thread.pendingHandoffs, [harness]: undefined },
      };
      return thread;
    },
    importTurns: async (input) => {
      const imported = new Set(
        messages.flatMap((message) => (message.nativeId ? [message.nativeId] : [])),
      );
      for (const turn of input.turns) {
        if (imported.has(turn.id)) continue;
        for (const [role, content] of [
          ["user", turn.prompt],
          ["assistant", turn.response],
        ] as const) {
          messages.push({
            id: `${turn.id}-${role}`,
            seq: messages.length + 1,
            role,
            content,
            harness: input.harness,
            nativeId: turn.id,
            createdAt: now,
          });
        }
      }
      thread = {
        ...thread,
        lastSeq: messages.length,
        bindings: {
          ...thread.bindings,
          [input.harness]: {
            harness: input.harness,
            sessionId: input.sessionId,
            lastSyncedSeq: messages.length,
            ...(input.turns.at(-1)?.id ? { nativeCursor: input.turns.at(-1)!.id } : {}),
            createdAt: thread.bindings[input.harness]?.createdAt ?? now,
            updatedAt: now,
          },
        },
      };
      return thread;
    },
    dropBinding: async (_threadId, harness, expectedSessionId) => {
      if (thread.bindings[harness]?.sessionId !== expectedSessionId) return thread;
      const bindings = { ...thread.bindings };
      delete bindings[harness];
      thread = { ...thread, bindings };
      return thread;
    },
  };
  return { controller, messages, thread: () => thread };
};

describe("native Relay host", () => {
  it("extracts only OpenCode's graceful continuation session id", () => {
    const output = [
      "A chat mentioned Continue opencode -s ses_not_selected",
      "\u001b[90mSession   \u001b[0m\u001b[1mExisting task\u001b[0m",
      "\u001b[90mContinue  \u001b[0m\u001b[1mopencode -s ses_selectedABC123\u001b[0m",
    ].join("\r\r\n");
    expect(openCodeSessionIdFromExit(output)).toBe("ses_selectedABC123");
    expect(openCodeSessionIdFromExit("Continue opencode -s ses_not_selected")).toBeUndefined();
  });

  it("owns the task before backend startup and releases it after startup failure", async () => {
    const { controller: base } = makeController();
    const events: Array<string> = [];
    const controller: NativeRelayController = {
      ...base,
      acquireLease: async () => {
        events.push("lease acquired");
        return {
          thread: await base.loadLocalThread(),
          release: async () => void events.push("lease released"),
        };
      },
    };

    await expect(
      launchNativeRelay(controller, {
        startBackend: async () => {
          events.push("backend started");
          throw new Error("startup failed");
        },
      }),
    ).rejects.toThrow("startup failed");
    expect(events).toEqual(["lease acquired", "backend started", "lease released"]);
  });

  it("launches the harness recovered while acquiring the native lease", async () => {
    const { controller: base } = makeController();
    const stale = await base.loadLocalThread();
    let startedHarness: Harness | undefined;
    const controller: NativeRelayController = {
      ...base,
      loadLocalThread: async () => stale,
      acquireLease: async () => ({
        thread: { ...stale, activeHarness: "opencode" },
        release: async () => {},
      }),
    };

    await expect(
      launchNativeRelay(controller, {
        startBackend: async (harness) => {
          startedHarness = harness;
          throw new Error("stop after harness selection");
        },
      }),
    ).rejects.toThrow("stop after harness selection");
    expect(startedHarness).toBe("opencode");
  });

  it("closes a detached backend when an external interrupt arrives before the native TUI", async () => {
    const { controller } = makeController();
    const signals = new EventEmitter();
    let closed = false;
    let launched = false;
    const backend: NativeBackend = {
      prepareSession: async () => {
        signals.emit("SIGINT");
        return { handoffInjected: false };
      },
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isIdle: async () => true,
      resolveSession: async () => undefined,
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => void (closed = true),
    };

    const previousExitCode = process.exitCode;
    try {
      await launchNativeRelay(controller, {
        signalSource: signals,
        startBackend: async () => backend,
        runTui: async () => {
          launched = true;
          return { reason: "exit", exitCode: 0 };
        },
      });
      expect(process.exitCode).toBe(130);
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
    expect(launched).toBe(false);
    expect(closed).toBe(true);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("returns promptly when interrupted during backend startup and closes a late backend", async () => {
    const { controller } = makeController();
    const signals = new EventEmitter();
    let resolveBackend!: (backend: NativeBackend) => void;
    let notifyStarting!: () => void;
    const backendReady = new Promise<NativeBackend>((resolve) => (resolveBackend = resolve));
    const starting = new Promise<void>((resolve) => (notifyStarting = resolve));
    let closed = false;
    let startupSignal: AbortSignal | undefined;
    const backend: NativeBackend = {
      prepareSession: async () => ({ handoffInjected: false }),
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isIdle: async () => true,
      resolveSession: async () => undefined,
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => void (closed = true),
    };

    const previousExitCode = process.exitCode;
    try {
      const launched = launchNativeRelay(controller, {
        signalSource: signals,
        startBackend: async (_harness, _cwd, signal) => {
          startupSignal = signal;
          notifyStarting();
          return backendReady;
        },
      });
      await starting;
      signals.emit("SIGINT");
      await launched;
      expect(process.exitCode).toBe(130);
      expect(closed).toBe(false);
      expect(startupSignal?.aborted).toBe(true);

      resolveBackend(backend);
      await Bun.sleep(0);
      expect(closed).toBe(true);
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("imports a native turn, hands it to the other harness, and keeps one backend alive", async () => {
    const { controller, messages } = makeController();
    const transcripts: Record<Harness, Array<NativeTranscriptTurn>> = {
      codex: [],
      opencode: [],
    };
    const injected: Record<Harness, Array<ReadonlyArray<RelayMessage>>> = {
      codex: [],
      opencode: [],
    };
    let activeBackends = 0;
    let maxActiveBackends = 0;
    let statusChecks = 0;

    const startBackend = async (harness: Harness): Promise<NativeBackend> => {
      activeBackends += 1;
      maxActiveBackends = Math.max(maxActiveBackends, activeBackends);
      const sessionId = `${harness}-session`;
      return {
        prepareSession: async () => ({ sessionId, handoffInjected: false }),
        inject: async (_id, delta) => void injected[harness].push(delta),
        read: async () => ({ turns: transcripts[harness], hiddenTurnIds: [] }),
        isIdle: async () => {
          statusChecks += 1;
          return true;
        },
        resolveSession: async (fallback) => fallback,
        command: () => ({ executable: harness, args: [], cwd: process.cwd() }),
        close: async () => {
          activeBackends -= 1;
        },
      };
    };

    let launches = 0;
    await launchNativeRelay(controller, {
      startBackend,
      runTui: async (command, onSwitchRequest) => {
        const harness = command.executable as Harness;
        launches += 1;
        transcripts[harness].push({
          id: `${harness}-turn`,
          prompt: `ask ${harness}`,
          response: `${harness} answered`,
        });
        if (launches === 1) {
          expect(await onSwitchRequest()).toBe(true);
          return { reason: "switch" };
        }
        return { reason: "exit", exitCode: 0 };
      },
    });

    expect(maxActiveBackends).toBe(1);
    expect(activeBackends).toBe(0);
    expect(statusChecks).toBe(3);
    expect(injected.opencode.flat().map((message) => message.content)).toEqual([
      "ask codex",
      "codex answered",
    ]);
    expect(messages.map((message) => message.content)).toEqual([
      "ask codex",
      "codex answered",
      "ask opencode",
      "opencode answered",
    ]);
  });

  it("vetoes a switch when an idle session becomes active during the submit window", async () => {
    const { controller } = makeController();
    let active = false;
    let waits = 0;
    let checks = 0;
    const backend: NativeBackend = {
      prepareSession: async () => ({
        sessionId: "codex-session",
        handoffInjected: false,
      }),
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isMaterialized: async () => true,
      isIdle: async () => {
        checks += 1;
        return !active;
      },
      resolveSession: async (fallback) => fallback,
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      wait: async () => {
        waits += 1;
        if (waits === 2) active = true;
      },
      runTui: async (_command, onSwitchRequest) => {
        expect(await onSwitchRequest()).toBe(false);
        return { reason: "exit", exitCode: 0 };
      },
    });

    expect(checks).toBe(2);
  });

  it("latches repeated direct-toggle input across native process launches", async () => {
    const { controller } = makeController();
    let clock = 0;
    let launches = 0;
    const backend = (harness: Harness): NativeBackend => ({
      prepareSession: async () => ({
        sessionId: `${harness}-session`,
        handoffInjected: false,
      }),
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isMaterialized: async () => true,
      isIdle: async () => true,
      resolveSession: async (fallback) => fallback,
      command: () => ({ executable: harness, args: [], cwd: process.cwd() }),
      close: async () => {},
    });

    await launchNativeRelay(controller, {
      startBackend: async (harness) => {
        if (harness === "opencode") clock = 5_000;
        return backend(harness);
      },
      now: () => clock,
      wait: async () => {},
      runTui: async (_command, onSwitchRequest) => {
        launches += 1;
        if (launches === 1) {
          expect(await onSwitchRequest()).toBe(true);
          return { reason: "switch" };
        }

        clock = 5_001;
        expect(await onSwitchRequest()).toBe(false);
        clock = 5_900;
        expect(await onSwitchRequest()).toBe(false);
        clock = 6_901;
        expect(await onSwitchRequest()).toBe(true);
        return { reason: "exit", exitCode: 0 };
      },
    });

    expect(launches).toBe(2);
  });

  it("lets the native Codex TUI create a cold thread and binds it after the first turn", async () => {
    const { controller, messages, thread } = makeController();
    const turns: Array<NativeTranscriptTurn> = [];
    const backend: NativeBackend = {
      prepareSession: async () => ({ handoffInjected: false }),
      inject: async () => {},
      read: async () => ({ turns, hiddenTurnIds: [] }),
      isIdle: async () => true,
      resolveSession: async () => "cold-codex-session",
      command: (sessionId) => {
        expect(sessionId).toBeUndefined();
        return { executable: "codex", args: [], cwd: process.cwd() };
      },
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      runTui: async () => {
        turns.push({
          id: "cold-turn",
          prompt: "first turn",
          response: "first answer",
        });
        return { reason: "exit", exitCode: 0 };
      },
    });

    expect(thread().bindings.codex?.sessionId).toBe("cold-codex-session");
    expect(messages.map((message) => message.content)).toEqual(["first turn", "first answer"]);
  });

  it("vetoes a cold-session switch while its first submitted turn materializes", async () => {
    const { controller } = makeController();
    const protectionModes: Array<boolean> = [];
    let clock = 0;
    const backend: NativeBackend = {
      prepareSession: async () => ({ handoffInjected: false }),
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isMaterialized: async () => false,
      isIdle: async () => true,
      resolveSession: async () => "materializing-session",
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      wait: async () => {},
      now: () => clock,
      runTui: async (_command, onSwitchRequest, coldLaunch) => {
        protectionModes.push(coldLaunch);
        expect(await onSwitchRequest(true)).toBe(false);
        clock = 1_001;
        expect(await onSwitchRequest(false)).toBe(true);
        return { reason: "exit", exitCode: 0 };
      },
    });

    expect(protectionModes).toEqual([true]);
  });

  it("allows an unresolved native selection only when the harness is globally idle", async () => {
    const { controller } = makeController();
    await controller.switchHarness("relay-thread", "opencode");
    let globallyIdle = false;
    const checkedSessions: Array<string | undefined> = [];
    const backend: NativeBackend = {
      prepareSession: async () => ({ handoffInjected: false }),
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isMaterialized: async () => true,
      isIdle: async (sessionId) => {
        checkedSessions.push(sessionId);
        return globallyIdle;
      },
      resolveSession: async () => undefined,
      command: () => ({ executable: "opencode", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      wait: async () => {},
      now: (() => {
        let clock = 0;
        return () => (clock += 1_001);
      })(),
      runTui: async (_command, onSwitchRequest) => {
        expect(await onSwitchRequest(true)).toBe(false);
        globallyIdle = true;
        expect(await onSwitchRequest(true)).toBe(true);
        return { reason: "exit", exitCode: 0 };
      },
    });

    expect(checkedSessions).toEqual(Array(4).fill(undefined));
  });

  it("protects a warm TUI after native /new creates an unmaterialized session", async () => {
    const { controller } = makeController();
    await controller.bind({
      threadId: "relay-thread",
      harness: "codex",
      sessionId: "warm-session",
      lastSyncedSeq: 0,
    });
    let resolvedSession = "warm-session";
    const coldLaunchModes: Array<boolean> = [];
    const backend: NativeBackend = {
      prepareSession: async () => ({ sessionId: "warm-session", handoffInjected: false }),
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isMaterialized: async (sessionId) => sessionId === "warm-session",
      isIdle: async () => true,
      resolveSession: async () => resolvedSession,
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      wait: async () => {},
      runTui: async (_command, onSwitchRequest, coldLaunch) => {
        coldLaunchModes.push(coldLaunch);
        resolvedSession = "new-session";
        expect(await onSwitchRequest(true)).toBe(false);
        return { reason: "exit", exitCode: 0 };
      },
    });

    expect(coldLaunchModes).toEqual([false]);
    await expect(
      controller.loadLocalThread().then((value) => value.bindings.codex?.sessionId),
    ).resolves.toBe("warm-session");
  });

  it("adopts a materialized native /new session without appending old context behind it", async () => {
    const { controller, messages, thread } = makeController();
    await controller.importTurns({
      threadId: "relay-thread",
      harness: "codex",
      sessionId: "warm-session",
      turns: [{ id: "warm-turn", prompt: "old prompt", response: "old answer" }],
    });
    let resolvedSession = "warm-session";
    const injections: Array<Array<string>> = [];
    const backend: NativeBackend = {
      prepareSession: async () => ({ sessionId: "warm-session", handoffInjected: false }),
      inject: async (_sessionId, delta) =>
        void injections.push(delta.map((message) => message.content)),
      read: async (sessionId) => ({
        turns:
          sessionId === "warm-session"
            ? [{ id: "warm-turn", prompt: "old prompt", response: "old answer" }]
            : [{ id: "new-turn", prompt: "new prompt", response: "new answer" }],
        hiddenTurnIds: [],
      }),
      isMaterialized: async () => true,
      isIdle: async () => true,
      resolveSession: async () => resolvedSession,
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      runTui: async () => {
        resolvedSession = "new-session";
        return { reason: "exit", exitCode: 0 };
      },
    });

    expect(injections).toEqual([]);
    expect(messages.map((message) => message.content)).toEqual([
      "old prompt",
      "old answer",
      "new prompt",
      "new answer",
    ]);
    expect(thread().bindings.codex).toMatchObject({
      sessionId: "new-session",
      lastSyncedSeq: 4,
      nativeCursor: "new-turn",
    });
  });

  it("adopts a previously standalone OpenCode session from its exit hint", async () => {
    const { controller, messages, thread } = makeController();
    await controller.switchHarness("relay-thread", "opencode");
    const backend: NativeBackend = {
      prepareSession: async () => ({ handoffInjected: false }),
      inject: async () => {},
      read: async (sessionId) => ({
        turns:
          sessionId === "ses_existing"
            ? [{ id: "existing-turn", prompt: "old prompt", response: "old answer" }]
            : [],
        hiddenTurnIds: [],
      }),
      isIdle: async () => true,
      resolveSession: async () => undefined,
      command: () => ({ executable: "opencode", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      runTui: async () => ({ reason: "exit", exitCode: 0, sessionIdHint: "ses_existing" }),
    });

    expect(messages.map((message) => message.content)).toEqual(["old prompt", "old answer"]);
    expect(thread().bindings.opencode).toMatchObject({
      sessionId: "ses_existing",
      lastSyncedSeq: 2,
      nativeCursor: "existing-turn",
    });
  });

  it("does not persist an unresumable empty Codex thread", async () => {
    const { controller, thread } = makeController();
    const backend: NativeBackend = {
      prepareSession: async () => ({ handoffInjected: false }),
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isIdle: async () => true,
      resolveSession: async () => "empty-codex-thread",
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      runTui: async () => ({ reason: "exit", exitCode: 0 }),
    });

    expect(thread().bindings.codex).toBeUndefined();
  });

  it("keeps a materialized Codex session after an interrupted cold turn", async () => {
    const { controller, thread } = makeController();
    const backend: NativeBackend = {
      prepareSession: async () => ({ handoffInjected: false }),
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isMaterialized: async () => true,
      isIdle: async () => true,
      resolveSession: async () => "interrupted-codex-thread",
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      runTui: async () => ({ reason: "exit", exitCode: 0 }),
    });

    expect(thread().bindings.codex?.sessionId).toBe("interrupted-codex-thread");
  });

  it("does not overwrite a warm native session's model selection", async () => {
    const { controller } = makeController();
    await controller.bind({
      threadId: "relay-thread",
      harness: "codex",
      sessionId: "codex-session",
      lastSyncedSeq: 0,
      model: "stale-relay-model",
    });
    const preparedModels: Array<string | undefined> = [];
    const commandModels: Array<string | undefined> = [];
    const protectionModes: Array<boolean> = [];
    let reads = 0;
    const backend: NativeBackend = {
      prepareSession: async (input) => {
        preparedModels.push(input.model);
        return { sessionId: "codex-session", handoffInjected: false };
      },
      inject: async () => {},
      read: async () => {
        reads += 1;
        return { turns: [], hiddenTurnIds: [] };
      },
      isIdle: async () => true,
      resolveSession: async (fallback) => fallback,
      command: (_sessionId, model) => {
        commandModels.push(model);
        return { executable: "codex", args: [], cwd: process.cwd() };
      },
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      runTui: async (_command, _onSwitchRequest, protectColdSubmit) => {
        protectionModes.push(protectColdSubmit);
        return { reason: "exit", exitCode: 0 };
      },
    });

    expect(preparedModels).toEqual([undefined]);
    expect(commandModels).toEqual([undefined]);
    expect(protectionModes).toEqual([false]);
    expect(reads).toBe(2);
  });

  it("replaces a definitively deleted binding with the complete canonical handoff", async () => {
    const { controller } = makeController();
    await controller.bind({
      threadId: "relay-thread",
      harness: "codex",
      sessionId: "deleted-session",
      lastSyncedSeq: 0,
    });
    await controller.importTurns({
      threadId: "relay-thread",
      harness: "codex",
      sessionId: "deleted-session",
      turns: [{ id: "old-turn", prompt: "preserve me", response: "preserved" }],
    });
    const preparedSessions: Array<string | undefined> = [];
    const preparedHandoffs: Array<Array<string>> = [];
    const injected: Array<string> = [];
    const backend: NativeBackend = {
      prepareSession: async (input) => {
        preparedSessions.push(input.sessionId);
        preparedHandoffs.push(input.handoff.map((message) => message.content));
        if (input.sessionId)
          throw new NativeSessionUnavailable("codex", input.sessionId, "deleted");
        return { sessionId: "replacement-session", handoffInjected: false };
      },
      inject: async (_sessionId, delta) =>
        void injected.push(...delta.map((message) => message.content)),
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isMaterialized: async () => true,
      isIdle: async () => true,
      resolveSession: async (fallback) => fallback,
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      runTui: async () => ({ reason: "exit", exitCode: 0 }),
    });

    expect(preparedSessions).toEqual(["deleted-session", undefined]);
    expect(preparedHandoffs).toEqual([[], ["preserve me", "preserved"]]);
    expect(injected).toEqual(["preserve me", "preserved"]);
  });

  it("keeps a binding when native preparation fails without a missing-session error", async () => {
    const { controller, thread } = makeController();
    await controller.bind({
      threadId: "relay-thread",
      harness: "codex",
      sessionId: "preserved-session",
      lastSyncedSeq: 0,
    });
    const backend: NativeBackend = {
      prepareSession: async () => {
        throw new Error("temporary transport failure");
      },
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isIdle: async () => true,
      resolveSession: async (fallback) => fallback,
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await expect(
      launchNativeRelay(controller, { startBackend: async () => backend }),
    ).rejects.toThrow("temporary transport failure");
    expect(thread().bindings.codex?.sessionId).toBe("preserved-session");
  });

  it("hands off pending cross-harness messages before importing out-of-band native turns", async () => {
    const { controller, messages } = makeController();
    await controller.bind({
      threadId: "relay-thread",
      harness: "codex",
      sessionId: "codex-session",
      lastSyncedSeq: 0,
    });
    await controller.importTurns({
      threadId: "relay-thread",
      harness: "codex",
      sessionId: "codex-session",
      turns: [
        {
          id: "codex-original",
          prompt: "codex prompt",
          response: "codex answer",
        },
      ],
    });
    await controller.bind({
      threadId: "relay-thread",
      harness: "opencode",
      sessionId: "opencode-session",
      lastSyncedSeq: 0,
    });
    await controller.importTurns({
      threadId: "relay-thread",
      harness: "opencode",
      sessionId: "opencode-session",
      turns: [{ id: "opencode-turn", prompt: "open prompt", response: "open answer" }],
    });
    await controller.switchHarness("relay-thread", "codex");

    const injected: Array<RelayMessage> = [];
    const backend: NativeBackend = {
      prepareSession: async () => ({
        sessionId: "codex-session",
        handoffInjected: false,
      }),
      inject: async (_sessionId, delta) => void injected.push(...delta),
      read: async () => ({
        turns: [
          {
            id: "codex-original",
            prompt: "codex prompt",
            response: "codex answer",
          },
          {
            id: "codex-out-of-band",
            prompt: "out of band",
            response: "out-of-band answer",
          },
        ],
        hiddenTurnIds: [],
      }),
      isIdle: async () => true,
      resolveSession: async (fallback) => fallback,
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    };

    await launchNativeRelay(controller, {
      startBackend: async () => backend,
      runTui: async () => ({ reason: "exit", exitCode: 0 }),
    });

    expect(injected.map((message) => message.content)).toEqual(["open prompt", "open answer"]);
    expect(messages.map((message) => message.content)).toEqual([
      "codex prompt",
      "codex answer",
      "open prompt",
      "open answer",
      "out of band",
      "out-of-band answer",
    ]);
  });

  it("abandons an uncertain native handoff before retrying on a fresh session", async () => {
    const { controller: base, thread } = makeController();
    await base.importTurns({
      threadId: "relay-thread",
      harness: "codex",
      sessionId: "codex-session",
      turns: [{ id: "codex-turn", prompt: "preserve", response: "preserved" }],
    });
    await base.bind({
      threadId: "relay-thread",
      harness: "opencode",
      sessionId: "old-opencode-session",
      lastSyncedSeq: 0,
    });

    let failCursorCommit = true;
    const controller: NativeRelayController = {
      ...base,
      bind: async (input) => {
        if (failCursorCommit && input.harness === "opencode" && input.lastSyncedSeq === 2) {
          throw new Error("simulated crash after vendor injection");
        }
        return base.bind(input);
      },
    };
    const injections: Array<{ sessionId: string; contents: Array<string> }> = [];
    const startBackend = async (): Promise<NativeBackend> => ({
      prepareSession: async (input) => ({
        sessionId: input.sessionId ?? "fresh-opencode-session",
        handoffInjected: false,
      }),
      inject: async (sessionId, messages) =>
        void injections.push({
          sessionId,
          contents: messages.map((message) => message.content),
        }),
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isIdle: async () => true,
      resolveSession: async (fallback) => fallback,
      command: () => ({ executable: "opencode", args: [], cwd: process.cwd() }),
      close: async () => {},
    });

    await expect(
      launchNativeRelay(controller, {
        startBackend,
        runTui: async () => ({ reason: "exit", exitCode: 0 }),
      }),
    ).rejects.toThrow("simulated crash after vendor injection");
    expect(thread().pendingHandoffs?.opencode?.sessionId).toBe("old-opencode-session");

    failCursorCommit = false;
    await launchNativeRelay(controller, {
      startBackend,
      runTui: async () => ({ reason: "exit", exitCode: 0 }),
    });

    expect(injections).toEqual([
      {
        sessionId: "old-opencode-session",
        contents: ["preserve", "preserved"],
      },
      {
        sessionId: "fresh-opencode-session",
        contents: ["preserve", "preserved"],
      },
    ]);
    expect(thread().bindings.opencode?.sessionId).toBe("fresh-opencode-session");
    expect(thread().pendingHandoffs?.opencode).toBeUndefined();
  });

  it("journals a cold Codex handoff before the backend creates its session", async () => {
    const { controller: base, thread } = makeController();
    await base.importTurns({
      threadId: "relay-thread",
      harness: "opencode",
      sessionId: "opencode-session",
      turns: [{ id: "opencode-turn", prompt: "carry", response: "carried" }],
    });
    await base.switchHarness("relay-thread", "codex");

    let failCursorCommit = true;
    const controller: NativeRelayController = {
      ...base,
      bind: async (input) => {
        if (failCursorCommit && input.harness === "codex" && input.lastSyncedSeq === 2) {
          throw new Error("simulated cold handoff crash");
        }
        return base.bind(input);
      },
    };
    const prepared: Array<{ sessionId: string; contents: Array<string> }> = [];
    let sessionNumber = 0;
    const startBackend = async (): Promise<NativeBackend> => ({
      preparesColdHandoff: true,
      prepareSession: async (input) => {
        const sessionId = `cold-codex-${++sessionNumber}`;
        prepared.push({
          sessionId,
          contents: input.handoff.map((message) => message.content),
        });
        return { sessionId, handoffInjected: true };
      },
      inject: async () => {
        throw new Error("cold Codex handoff must use prepareSession");
      },
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
      isMaterialized: async () => true,
      isIdle: async () => true,
      resolveSession: async (fallback) => fallback,
      command: () => ({ executable: "codex", args: [], cwd: process.cwd() }),
      close: async () => {},
    });

    await expect(
      launchNativeRelay(controller, {
        startBackend,
        runTui: async () => ({ reason: "exit", exitCode: 0 }),
      }),
    ).rejects.toThrow("simulated cold handoff crash");
    expect(thread().pendingHandoffs?.codex?.sessionId).toBeUndefined();

    failCursorCommit = false;
    await launchNativeRelay(controller, {
      startBackend,
      runTui: async () => ({ reason: "exit", exitCode: 0 }),
    });

    expect(prepared).toEqual([
      { sessionId: "cold-codex-1", contents: ["carry", "carried"] },
      { sessionId: "cold-codex-2", contents: ["carry", "carried"] },
    ]);
    expect(thread().bindings.codex?.sessionId).toBe("cold-codex-2");
    expect(thread().pendingHandoffs?.codex).toBeUndefined();
  });
});
