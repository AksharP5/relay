import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import type { Harness, RelayMessage, RelayThread } from "../src/domain.ts";
import { RelayApp } from "../src/tui/app.tsx";
import type { TuiController, TuiSnapshot } from "../src/tui/controller.ts";

let renderer: Awaited<ReturnType<typeof testRender>> | undefined;

const now = "2026-07-12T00:00:00.000Z";

const makeThread = (harness: Harness): RelayThread => ({
  id: "thread-1",
  title: "Repair checkout",
  cwd: "/work/relay",
  activeHarness: harness,
  bindings: {},
  lastSeq: 2,
  createdAt: now,
  updatedAt: now,
});

const initial: TuiSnapshot = {
  thread: null,
  messages: [],
  harnesses: [
    { harness: "codex", installed: true, healthy: true, version: "codex 1" },
    { harness: "opencode", installed: true, healthy: true, version: "opencode 1" },
  ],
  capabilities: [
    {
      harness: "codex",
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol", isDefault: true }],
      commands: [
        { name: "model", description: "Choose the Codex model", source: "relay" },
        { name: "review", description: "Review the working tree", source: "native" },
      ],
    },
    {
      harness: "opencode",
      models: [{ id: "openai/gpt-5.6-sol", name: "openai/gpt-5.6-sol" }],
      commands: [
        { name: "model", description: "Choose the OpenCode model", source: "relay" },
        { name: "commit", description: "Create a commit", source: "native" },
      ],
    },
  ],
};

afterEach(() => {
  renderer?.renderer.destroy();
  renderer = undefined;
});

describe("Relay TUI", () => {
  it("switches harnesses in place and sends the next turn through the selection", async () => {
    const switches: Array<Harness> = [];
    const asks: Array<{ prompt: string; harness: Harness }> = [];
    const messages: ReadonlyArray<RelayMessage> = [
      {
        id: "user-1",
        seq: 1,
        role: "user",
        content: "Inspect the checkout failure",
        harness: "opencode",
        createdAt: now,
      },
      {
        id: "assistant-1",
        seq: 2,
        role: "assistant",
        content: "The failing branch is isolated.",
        harness: "opencode",
        createdAt: now,
      },
    ];
    const controller: TuiController = {
      load: async () => initial,
      switchHarness: async (harness) => {
        switches.push(harness);
        return null;
      },
      refreshCapabilities: async (harness) =>
        initial.capabilities.find((item) => item.harness === harness)!,
      ask: async (input) => {
        asks.push({ prompt: input.prompt, harness: input.harness });
        return { thread: makeThread(input.harness), messages };
      },
    };

    renderer = await testRender(() => <RelayApp controller={controller} initial={initial} />, {
      width: 88,
      height: 28,
    });
    await renderer.renderOnce();
    expect(renderer.captureCharFrame()).toContain("Codex ▾");

    renderer.mockInput.pressKey("r", { ctrl: true });
    await renderer.waitForFrame((frame) => frame.includes("Select harness"));
    renderer.mockInput.pressArrow("down");
    renderer.mockInput.pressEnter();
    await renderer.waitFor(() => switches.length === 1);
    expect(switches).toEqual(["opencode"]);
    await renderer.waitForFrame((frame) => frame.includes("OpenCode ▾"));

    await renderer.mockInput.typeText("Inspect the checkout failure");
    renderer.mockInput.pressEnter();
    await renderer.waitFor(() => asks.length === 1);
    expect(asks).toEqual([{ prompt: "Inspect the checkout failure", harness: "opencode" }]);
    await renderer.waitForFrame((frame) => frame.includes("The failing branch is isolated."));
    expect(renderer.captureCharFrame()).toContain("Repair checkout");
  });

  it("keeps the draft when a turn fails", async () => {
    const controller: TuiController = {
      load: async () => initial,
      switchHarness: async () => null,
      refreshCapabilities: async (harness) =>
        initial.capabilities.find((item) => item.harness === harness)!,
      ask: async () => {
        throw new Error("Harness connection failed");
      },
    };

    renderer = await testRender(() => <RelayApp controller={controller} initial={initial} />, {
      width: 72,
      height: 24,
    });
    await renderer.mockInput.typeText("Do not lose this draft");
    renderer.mockInput.pressEnter();
    await renderer.waitForFrame((frame) => frame.includes("Harness connection failed"));
    const frame = renderer.captureCharFrame();
    expect(frame).toContain("Do not lose this draft");
    expect(frame).toContain("Codex ▾");
  });

  it("renders ephemeral native output while a turn is running", async () => {
    const turn = Promise.withResolvers<Pick<TuiSnapshot, "thread" | "messages">>();
    const controller: TuiController = {
      load: async () => initial,
      switchHarness: async () => null,
      refreshCapabilities: async (harness) =>
        initial.capabilities.find((item) => item.harness === harness)!,
      ask: async (input) => {
        input.onProgress?.({ type: "text", text: "Streaming native response" });
        return turn.promise;
      },
    };

    renderer = await testRender(() => <RelayApp controller={controller} initial={initial} />, {
      width: 72,
      height: 24,
    });
    await renderer.mockInput.typeText("Start the turn");
    renderer.mockInput.pressEnter();
    await renderer.waitForFrame((frame) => frame.includes("Streaming native response"));

    turn.resolve({ thread: makeThread("codex"), messages: [] });
    await renderer.waitForFrame((frame) => !frame.includes("Streaming native response"));
  });
});
