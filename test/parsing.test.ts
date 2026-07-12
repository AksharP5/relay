import { describe, expect, it } from "vitest";
import { parseCodexOutput, parseJsonLines, parseOpenCodeOutput } from "../src/harnesses/parsing.ts";

describe("harness output parsing", () => {
  it("ignores non-JSON diagnostic lines", () => {
    expect(parseJsonLines('warning\n{"type":"ok"}\n')).toEqual([{ type: "ok" }]);
  });

  it("extracts the Codex thread and final agent message", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Checking." },
      }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } }),
    ].join("\n");
    expect(parseCodexOutput(output)).toEqual({ sessionId: "codex-1", text: "Done." });
  });

  it("extracts OpenCode text parts and the documented top-level session id", () => {
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "open-1" }),
      JSON.stringify({ type: "text", part: { text: "Hello " } }),
      JSON.stringify({ type: "text", part: { text: "world" } }),
    ].join("\n");
    expect(parseOpenCodeOutput(output)).toEqual({ sessionId: "open-1", text: "Hello world" });
  });

  it("does not mistake a nested tool field for the OpenCode session id", () => {
    const output = JSON.stringify({
      type: "tool_use",
      sessionID: "open-1",
      part: { state: { output: { sessionID: "unrelated" } } },
    });
    expect(parseOpenCodeOutput(output).sessionId).toBe("open-1");
  });
});
