import { describe, expect, it } from "vitest";
import {
  codexCompletedCursor,
  codexThreadAllowsDetach,
  parseCodexNativeTurns,
  selectResolvedCodexSession,
} from "../src/native/codex-backend.ts";

describe("Codex native completed cursor", () => {
  it("selects the newest completed turn from a descending bounded page", () => {
    expect(
      codexCompletedCursor({
        data: [
          { id: "active", status: "inProgress" },
          { id: "failed", status: "failed" },
          { id: "completed-newest", status: "completed" },
          { id: "completed-older", status: "completed" },
        ],
      }),
    ).toBe("completed-newest");
    expect(
      codexCompletedCursor({ data: [{ id: "active", status: "inProgress" }] }),
    ).toBeUndefined();
  });
});

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

describe("Codex native detach status", () => {
  it("allows only documented non-active terminal states", () => {
    for (const type of ["idle", "notLoaded", "systemError"]) {
      expect(codexThreadAllowsDetach({ thread: { status: { type } } })).toBe(true);
    }
    expect(codexThreadAllowsDetach({ thread: { status: { type: "active" } } })).toBe(false);
    expect(codexThreadAllowsDetach({ thread: { status: { type: "futureStatus" } } })).toBe(false);
    expect(codexThreadAllowsDetach({ thread: {} })).toBe(false);
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
