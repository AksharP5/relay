import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";

import type { Harness, NativeTranscriptTurn, RelayMessage, RelayThread } from "../src/domain.ts";
import type { NativeRelayController } from "../src/native/controller.ts";
import { NativeSessionUnavailable } from "../src/native/errors.ts";
import { launchNativeRelay, type NativeBackend } from "../src/native/relay-host.ts";
import { selectHarness } from "../src/native/selector.ts";

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
    acquireLease: async () => ({ release: async () => {} }),
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
        pendingHandoffs: { ...thread.pendingHandoffs, [input.harness]: undefined },
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
  it("owns the task before backend startup and releases it after startup failure", async () => {
    const { controller: base } = makeController();
    const events: Array<string> = [];
    const controller: NativeRelayController = {
      ...base,
      acquireLease: async () => {
        events.push("lease acquired");
        return { release: async () => void events.push("lease released") };
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
      selectHarness: async () => "opencode",
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
    expect(statusChecks).toBe(1);
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
      selectHarness: async () => undefined,
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
      selectHarness: async () => undefined,
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
    const backend: NativeBackend = {
      prepareSession: async (input) => {
        preparedModels.push(input.model);
        return { sessionId: "codex-session", handoffInjected: false };
      },
      inject: async () => {},
      read: async () => ({ turns: [], hiddenTurnIds: [] }),
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
      runTui: async () => ({ reason: "exit", exitCode: 0 }),
    });

    expect(preparedModels).toEqual([undefined]);
    expect(commandModels).toEqual([undefined]);
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

describe("native harness selector", () => {
  it("changes harness with arrows and restores the terminal", async () => {
    class Input extends EventEmitter {
      isRaw = false;
      modes: Array<boolean> = [];
      pauseCalls = 0;
      setRawMode(enabled: boolean) {
        this.isRaw = enabled;
        this.modes.push(enabled);
      }
      resume() {}
      pause() {
        this.pauseCalls += 1;
      }
    }
    const input = new Input();
    const output: Array<string> = [];
    const selection = selectHarness("opencode", {
      input,
      output: { write: (value) => void output.push(String(value)) },
    });
    input.emit("data", "\u001b[B\r");

    expect(await selection).toBe("codex");
    expect(input.modes).toEqual([true, false]);
    expect(input.pauseCalls).toBe(1);
    expect(input.listenerCount("data")).toBe(0);
    expect(output.join("")).toContain("\u001b[?1049l");
  });

  it("restores the terminal when Relay is terminated inside its selector", async () => {
    class Input extends EventEmitter {
      isRaw = false;
      setRawMode(enabled: boolean) {
        this.isRaw = enabled;
      }
      resume() {}
      pause() {}
    }
    const input = new Input();
    const signals = new EventEmitter();
    const output: Array<string> = [];
    const selection = selectHarness("codex", {
      input,
      output: { write: (value) => void output.push(String(value)) },
      signalSource: signals,
    });
    signals.emit("SIGINT");

    expect(await selection).toBeUndefined();
    expect(input.isRaw).toBe(false);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(output.join("")).toContain("\u001b[?1049l");
  });
});
