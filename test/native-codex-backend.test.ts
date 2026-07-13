import { describe, expect, it } from "vitest";

import { parseCodexNativeTurns, selectResolvedCodexSession } from "../src/native/codex-backend.ts";

describe("Codex native transcript", () => {
  it("imports completed user/final-answer turns and ignores commentary or controls", () => {
    expect(
      parseCodexNativeTurns({
        thread: {
          turns: [
            {
              id: "turn-1",
              status: "completed",
              items: [
                { type: "userMessage", content: [{ type: "text", text: "Fix the parser" }] },
                { type: "agentMessage", phase: "commentary", text: "Inspecting" },
                { type: "agentMessage", phase: "final_answer", text: "Fixed and tested." },
              ],
            },
            { id: "compact", status: "completed", items: [{ type: "contextCompaction" }] },
            {
              id: "failed",
              status: "failed",
              items: [
                { type: "userMessage", content: [{ type: "text", text: "Do not import" }] },
                { type: "agentMessage", text: "failed" },
              ],
            },
          ],
        },
      }),
    ).toEqual([{ id: "turn-1", prompt: "Fix the parser", response: "Fixed and tested." }]);
  });
});

describe("Codex native session resolution", () => {
  it("allows the native TUI to return to its baseline session", () => {
    const baseline = new Set(["thread-a"]);
    expect(
      selectResolvedCodexSession({
        loaded: ["thread-a", "thread-b"],
        baseline,
        recency: ["thread-a", "thread-b"],
        fallback: "thread-a",
      }),
    ).toBe("thread-a");
    expect(
      selectResolvedCodexSession({
        loaded: ["thread-a", "thread-b"],
        baseline,
        recency: ["thread-b", "thread-a"],
        fallback: "thread-a",
      }),
    ).toBe("thread-b");
  });
});
