import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";

import type { Harness, NativeTranscriptTurn, RelayMessage, RelayThread } from "../src/domain.ts";
import type { NativeRelayController } from "../src/native/controller.ts";
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
    switchHarness: async (_threadId, harness) => {
      thread = { ...thread, activeHarness: harness };
      return thread;
    },
    delta: async (_threadId, harness) => {
      const after = thread.bindings[harness]?.lastSyncedSeq ?? 0;
      return {
        thread,
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
  };
  return { controller, messages, thread: () => thread };
};

describe("native Relay host", () => {
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
        read: async () => transcripts[harness],
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
      read: async () => turns,
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
        turns.push({ id: "cold-turn", prompt: "first turn", response: "first answer" });
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
      read: async () => [],
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
});
