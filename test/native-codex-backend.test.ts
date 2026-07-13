import { describe, expect, it } from "vitest";

import { parseCodexNativeTurns } from "../src/native/codex-backend.ts";

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
