import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, HarnessControlInput, HarnessTurnInput } from "../src/domain.ts";
import { HarnessError } from "../src/errors.ts";
import { buildHandoff } from "../src/handoff.ts";
import { HarnessService } from "../src/harnesses/harness-service.ts";
import { RelayService } from "../src/services/relay-service.ts";
import { ThreadStore } from "../src/services/thread-store.ts";

let directory: string | undefined;

const makeLayer = (harnesses: typeof HarnessService.Service) =>
  RelayService.layer.pipe(
    Layer.provide(Layer.mergeAll(ThreadStore.layer, Layer.succeed(HarnessService, harnesses))),
  );

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  delete process.env.RELAY_DATA_DIR;
});

describe("Relay session transitions", () => {
  it("rejects a headless turn while the native task owner is active", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-run-lease-"));
    process.env.RELAY_DATA_DIR = directory;
    let harnessCalls = 0;
    const harnesses: typeof HarnessService.Service = {
      run: (harness) => {
        harnessCalls += 1;
        return Effect.succeed({ sessionId: `${harness}-session`, text: "unexpected" });
      },
      control: () => Effect.succeed({ message: "unexpected" }),
      status: (harness) => Effect.succeed({ harness, installed: true, healthy: true }),
      capabilities: (harness) => Effect.succeed({ harness, models: [], commands: [] }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const store = yield* ThreadStore;
        const thread = yield* relay.newThread({
          title: "Owned native task",
          cwd: process.cwd(),
          harness: "codex",
        });
        const owner = yield* store.acquireRunLease(thread.id);
        const error = yield* relay
          .ask({ threadId: thread.id, prompt: "must not run" })
          .pipe(Effect.flip);
        expect((error as Error).message).toContain("already open");
        yield* Effect.promise(owner.release);
      }).pipe(Effect.provide(Layer.merge(makeLayer(harnesses), ThreadStore.layer))),
    );

    expect(harnessCalls).toBe(0);
  });

  it("compacts a native session without adding a fake turn or resending history", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-compact-"));
    process.env.RELAY_DATA_DIR = directory;
    const turns: Array<{ harness: Harness; input: HarnessTurnInput }> = [];
    const controls: Array<{ harness: Harness; input: HarnessControlInput }> = [];
    const harnesses: typeof HarnessService.Service = {
      run: (harness, input) =>
        Effect.sync(() => {
          turns.push({ harness, input });
          return { sessionId: `${harness}-session`, text: `${harness} response` };
        }),
      control: (harness, input) =>
        Effect.sync(() => {
          controls.push({ harness, input });
          return { message: `${harness} compacted` };
        }),
      status: (harness) => Effect.succeed({ harness, installed: true, healthy: true }),
      capabilities: (harness) => Effect.succeed({ harness, models: [], commands: [] }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const thread = yield* relay.newThread({
          title: "Compaction continuity",
          cwd: process.cwd(),
          harness: "codex",
        });
        yield* relay.ask({ threadId: thread.id, prompt: "First" });
        const compacted = yield* relay.control({
          threadId: thread.id,
          harness: "codex",
          action: "compact",
        });
        expect(compacted.thread.lastSeq).toBe(2);
        expect(yield* relay.historyFor(thread.id)).toHaveLength(2);
        yield* relay.ask({ threadId: thread.id, prompt: "After compact" });
      }).pipe(Effect.provide(makeLayer(harnesses))),
    );

    expect(controls).toHaveLength(1);
    expect(controls[0]?.input.sessionId).toBe("codex-session");
    expect(turns[1]?.input).toMatchObject({
      sessionId: "codex-session",
      prompt: "After compact",
      handoff: [],
    });
  });

  it("does not advance history or a cold binding when a switched harness fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-retry-"));
    process.env.RELAY_DATA_DIR = directory;
    const openCodeAttempts: Array<HarnessTurnInput> = [];
    let failOpenCode = true;
    const harnesses: typeof HarnessService.Service = {
      run: (harness, input) => {
        if (harness === "opencode") {
          openCodeAttempts.push(input);
          if (failOpenCode) {
            failOpenCode = false;
            return Effect.fail(
              new HarnessError({ harness, message: "context limit", stderr: "too many tokens" }),
            );
          }
        }
        return Effect.succeed({ sessionId: `${harness}-session`, text: `${harness} response` });
      },
      control: (_harness, _input) => Effect.succeed({ message: "ok" }),
      status: (harness) => Effect.succeed({ harness, installed: true, healthy: true }),
      capabilities: (harness) => Effect.succeed({ harness, models: [], commands: [] }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const thread = yield* relay.newThread({
          title: "Failure retry",
          cwd: process.cwd(),
          harness: "codex",
        });
        yield* relay.ask({ threadId: thread.id, prompt: "Established context" });
        yield* relay
          .ask({ threadId: thread.id, harness: "opencode", prompt: "Try OpenCode" })
          .pipe(Effect.flip);
        const unchanged = yield* relay.current();
        expect(unchanged.lastSeq).toBe(2);
        expect(unchanged.bindings.opencode).toBeUndefined();
        yield* relay.ask({ threadId: thread.id, harness: "opencode", prompt: "Try OpenCode" });
      }).pipe(Effect.provide(makeLayer(harnesses))),
    );

    expect(openCodeAttempts).toHaveLength(2);
    expect(openCodeAttempts[0]?.sessionId).toBeUndefined();
    expect(openCodeAttempts[1]?.sessionId).toBeUndefined();
    expect(openCodeAttempts[0]?.handoff.map((message) => message.content)).toEqual([
      "Established context",
      "codex response",
    ]);
    expect(openCodeAttempts[1]?.handoff.map((message) => message.content)).toEqual([
      "Established context",
      "codex response",
    ]);
  });

  it("abandons an uncertain warm session so retry cannot duplicate a native append", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-warm-retry-"));
    process.env.RELAY_DATA_DIR = directory;
    const attempts: Array<HarnessTurnInput> = [];
    let call = 0;
    const harnesses: typeof HarnessService.Service = {
      run: (harness, input) => {
        attempts.push(input);
        call += 1;
        if (call === 2) {
          return Effect.fail(
            new HarnessError({
              harness,
              message: "native state may have advanced",
              sessionState: "uncertain",
            }),
          );
        }
        return Effect.succeed({ sessionId: `session-${call}`, text: `response-${call}` });
      },
      control: () => Effect.succeed({ message: "ok" }),
      status: (harness) => Effect.succeed({ harness, installed: true, healthy: true }),
      capabilities: (harness) => Effect.succeed({ harness, models: [], commands: [] }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const thread = yield* relay.newThread({
          title: "Warm retry",
          cwd: process.cwd(),
          harness: "codex",
        });
        yield* relay.ask({ threadId: thread.id, prompt: "First", model: "gpt-test" });
        yield* relay.ask({ threadId: thread.id, prompt: "Second" }).pipe(Effect.flip);
        expect((yield* relay.current()).bindings.codex).toBeUndefined();
        expect((yield* relay.current()).preferredModels?.codex).toBe("gpt-test");
        yield* relay.ask({ threadId: thread.id, prompt: "Second" });
      }).pipe(Effect.provide(makeLayer(harnesses))),
    );

    expect(attempts[1]?.sessionId).toBe("session-1");
    expect(attempts[2]?.sessionId).toBeUndefined();
    expect(attempts[2]?.model).toBe("gpt-test");
    expect(attempts[2]?.handoff.map((message) => message.content)).toEqual(["First", "response-1"]);
  });

  it("preserves a context-limited warm session so compact targets the same binding", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-context-compact-"));
    process.env.RELAY_DATA_DIR = directory;
    let calls = 0;
    const compactedSessions: Array<string> = [];
    const harnesses: typeof HarnessService.Service = {
      run: (harness) => {
        calls += 1;
        return calls === 1
          ? Effect.succeed({ sessionId: "context-session", text: "first response" })
          : Effect.fail(
              new HarnessError({
                harness,
                message: "context limit",
                sessionState: "preserve",
              }),
            );
      },
      control: (_harness, input) => {
        compactedSessions.push(input.sessionId);
        return Effect.succeed({ message: "compacted" });
      },
      status: (harness) => Effect.succeed({ harness, installed: true, healthy: true }),
      capabilities: (harness) => Effect.succeed({ harness, models: [], commands: [] }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const thread = yield* relay.newThread({
          title: "Context compact",
          cwd: process.cwd(),
          harness: "codex",
        });
        yield* relay.ask({ threadId: thread.id, prompt: "First" });
        yield* relay.ask({ threadId: thread.id, prompt: "Too large" }).pipe(Effect.flip);
        expect((yield* relay.current()).bindings.codex?.sessionId).toBe("context-session");
        yield* relay.control({ threadId: thread.id, harness: "codex", action: "compact" });
      }).pipe(Effect.provide(makeLayer(harnesses))),
    );

    expect(compactedSessions).toEqual(["context-session"]);
  });

  it("rejects an interleaved OpenCode undo before mutating the native session", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-interleaved-undo-"));
    process.env.RELAY_DATA_DIR = directory;
    const controls: Array<{ harness: Harness; input: HarnessControlInput }> = [];
    const harnesses: typeof HarnessService.Service = {
      run: (harness) =>
        Effect.succeed({ sessionId: `${harness}-session`, text: `${harness} response` }),
      control: (harness, input) =>
        Effect.sync(() => {
          controls.push({ harness, input });
          return { message: "native state changed" };
        }),
      status: (harness) => Effect.succeed({ harness, installed: true, healthy: true }),
      capabilities: (harness) => Effect.succeed({ harness, models: [], commands: [] }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const thread = yield* relay.newThread({
          title: "Interleaved undo",
          cwd: process.cwd(),
          harness: "opencode",
        });
        yield* relay.ask({ threadId: thread.id, harness: "opencode", prompt: "OpenCode turn" });
        yield* relay.ask({ threadId: thread.id, harness: "codex", prompt: "Newer Codex turn" });
        const error = yield* relay
          .control({ threadId: thread.id, harness: "opencode", action: "undo" })
          .pipe(Effect.flip);
        expect((error as Error).message).toContain(
          "latest Relay turn was not produced by opencode",
        );
        expect(yield* relay.historyFor(thread.id)).toHaveLength(4);
      }).pipe(Effect.provide(makeLayer(harnesses))),
    );

    expect(controls).toHaveLength(0);
  });

  it("re-hands off cross-harness messages removed by OpenCode undo", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-undo-handoff-"));
    process.env.RELAY_DATA_DIR = directory;
    const turns: Array<{ harness: Harness; input: HarnessTurnInput }> = [];
    const harnesses: typeof HarnessService.Service = {
      run: (harness, input) =>
        Effect.sync(() => {
          turns.push({ harness, input });
          return { sessionId: `${harness}-session`, text: `${harness}:${input.prompt}` };
        }),
      control: () => Effect.succeed({ message: "native undo complete" }),
      status: (harness) => Effect.succeed({ harness, installed: true, healthy: true }),
      capabilities: (harness) => Effect.succeed({ harness, models: [], commands: [] }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const thread = yield* relay.newThread({
          title: "Undo handoff",
          cwd: process.cwd(),
          harness: "codex",
        });
        yield* relay.ask({ threadId: thread.id, harness: "codex", prompt: "C1" });
        yield* relay.ask({ threadId: thread.id, harness: "opencode", prompt: "O1" });
        yield* relay.ask({ threadId: thread.id, harness: "codex", prompt: "C2" });
        yield* relay.ask({ threadId: thread.id, harness: "opencode", prompt: "O2" });
        yield* relay.control({ threadId: thread.id, harness: "opencode", action: "undo" });
        yield* relay.ask({ threadId: thread.id, harness: "opencode", prompt: "O3" });
      }).pipe(Effect.provide(makeLayer(harnesses))),
    );

    const finalOpenCode = turns.at(-1)?.input;
    expect(finalOpenCode?.prompt).toBe("O3");
    expect(finalOpenCode?.handoff.map((message) => message.content)).toEqual(["C2", "codex:C2"]);
  });

  it("bounds a cold handoff while keeping omitted history discoverable", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-bounded-handoff-"));
    process.env.RELAY_DATA_DIR = directory;
    let openCodeInput: HarnessTurnInput | undefined;
    const harnesses: typeof HarnessService.Service = {
      run: (harness, input) => {
        if (harness === "opencode") openCodeInput = input;
        return Effect.succeed({
          sessionId: `${harness}-session`,
          text: harness === "codex" ? "x".repeat(180_000) : "received bounded handoff",
        });
      },
      control: () => Effect.succeed({ message: "ok" }),
      status: (harness) => Effect.succeed({ harness, installed: true, healthy: true }),
      capabilities: (harness) => Effect.succeed({ harness, models: [], commands: [] }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const thread = yield* relay.newThread({
          title: "Bounded handoff",
          cwd: process.cwd(),
          harness: "codex",
        });
        yield* relay.ask({ threadId: thread.id, harness: "codex", prompt: "Large response" });
        yield* relay.ask({ threadId: thread.id, harness: "opencode", prompt: "Continue" });
      }).pipe(Effect.provide(makeLayer(harnesses))),
    );

    expect(openCodeInput).toBeDefined();
    expect(
      openCodeInput!.handoff.reduce((sum, message) => sum + message.content.length, 0),
    ).toBeLessThanOrEqual(120_000);
    expect(openCodeInput!.handoffOmittedMessages).toBeGreaterThan(0);
    expect(buildHandoff(openCodeInput!.handoff, openCodeInput!.handoffOmittedMessages)).toContain(
      "relay history",
    );
  });

  it("rejects native controls from a different working directory", async () => {
    directory = await mkdtemp(join(tmpdir(), "relay-foreign-control-"));
    process.env.RELAY_DATA_DIR = directory;
    let controls = 0;
    const harnesses: typeof HarnessService.Service = {
      run: (harness) =>
        Effect.succeed({ sessionId: `${harness}-session`, text: `${harness} response` }),
      control: () => {
        controls += 1;
        return Effect.succeed({ message: "mutated foreign task" });
      },
      status: (harness) => Effect.succeed({ harness, installed: true, healthy: true }),
      capabilities: (harness) => Effect.succeed({ harness, models: [], commands: [] }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const relay = yield* RelayService;
        const store = yield* ThreadStore;
        const thread = yield* relay.newThread({
          title: "Foreign task",
          cwd: tmpdir(),
          harness: "opencode",
        });
        const seeded = yield* store.commitTurn(thread, {
          harness: "opencode",
          prompt: "seed",
          response: "seeded",
          sessionId: "opencode-session",
          bindingCreatedAt: thread.createdAt,
        });
        const error = yield* relay
          .control({ threadId: seeded.thread.id, harness: "opencode", action: "compact" })
          .pipe(Effect.flip);
        expect((error as Error).message).toContain("This task belongs to");
      }).pipe(Effect.provide(Layer.merge(makeLayer(harnesses), ThreadStore.layer))),
    );
    expect(controls).toBe(0);
  });
});
