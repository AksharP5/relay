import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness, RelayMessage, RelayThread } from "../src/domain.ts";
import { RelayService } from "../src/services/relay-service.ts";
import { makeTuiController } from "../src/tui/controller.ts";

const runtimes: Array<ManagedRuntime.ManagedRuntime<RelayService, never>> = [];
const now = "2026-07-12T00:00:00.000Z";

const thread = (id: string, cwd: string, harness: Harness = "codex"): RelayThread => ({
  id,
  title: id,
  cwd,
  activeHarness: harness,
  bindings: {},
  lastSeq: 0,
  createdAt: now,
  updatedAt: now,
});

const message = (id: string, content: string): RelayMessage => ({
  id,
  seq: 1,
  role: "user",
  content,
  harness: "codex",
  createdAt: now,
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("TUI task routing", () => {
  it("selects the most recent task for the launch directory before reading history", async () => {
    const other = thread("other-project", "/tmp/other-project");
    const local = thread("local-project", process.cwd(), "opencode");
    let selected = other;
    let askedThreadId: string | undefined;
    const histories = new Map([
      [other.id, [message("other-message", "private other-project context")]],
      [local.id, [message("local-message", "local context")]],
    ]);

    const service: typeof RelayService.Service = {
      newThread: () => Effect.die("not expected"),
      ask: (input) =>
        Effect.sync(() => {
          askedThreadId = input.threadId;
          return {
            thread: local,
            response: message("response", "stayed pinned"),
            createdBinding: false,
            handedOffMessages: 0,
          };
        }),
      switchHarness: () => Effect.die("not expected"),
      useThread: (id) =>
        Effect.sync(() => {
          selected = id === local.id ? local : other;
          return selected;
        }),
      current: () => Effect.succeed(selected),
      list: () => Effect.succeed([other, local]),
      history: () => Effect.succeed(histories.get(selected.id) ?? []),
      historyFor: (id) => Effect.succeed(histories.get(id) ?? []),
      historyForDisplay: (id) => Effect.succeed(histories.get(id) ?? []),
      doctor: () => Effect.succeed([]),
      dataRoot: "/tmp/relay-test",
    };
    const runtime = ManagedRuntime.make(Layer.succeed(RelayService, service));
    runtimes.push(runtime);

    const controller = makeTuiController(runtime);
    const snapshot = await controller.load();
    expect(snapshot.thread?.id).toBe(local.id);
    expect(snapshot.messages.map((item) => item.content)).toEqual(["local context"]);

    selected = thread("another-local-task", process.cwd());
    await controller.ask({ prompt: "Stay on the displayed task", harness: "opencode" });
    expect(askedThreadId).toBe(local.id);
  });

  it("creates a local task on first submit instead of mutating another project's task", async () => {
    const other = thread("other-project", "/tmp/other-project");
    let selected = other;
    let created: RelayThread | undefined;
    const response = message("response", "created locally");

    const service: typeof RelayService.Service = {
      newThread: (input) =>
        Effect.sync(() => {
          created = thread("new-local-project", input.cwd, input.harness);
          selected = created;
          return created;
        }),
      ask: () =>
        Effect.sync(() => ({
          thread: selected,
          response,
          createdBinding: true,
          handedOffMessages: 0,
        })),
      switchHarness: () => Effect.die("not expected"),
      useThread: () => Effect.die("not expected"),
      current: () => Effect.succeed(selected),
      list: () => Effect.succeed([other]),
      history: () => Effect.succeed([response]),
      historyFor: () => Effect.succeed([response]),
      historyForDisplay: () => Effect.succeed([response]),
      doctor: () => Effect.succeed([]),
      dataRoot: "/tmp/relay-test",
    };
    const runtime = ManagedRuntime.make(Layer.succeed(RelayService, service));
    runtimes.push(runtime);

    const result = await makeTuiController(runtime).ask({
      prompt: "Fix the local parser",
      harness: "opencode",
    });
    expect(created?.cwd).toBe(process.cwd());
    expect(created?.activeHarness).toBe("opencode");
    expect(result.thread?.id).toBe("new-local-project");
  });
});
