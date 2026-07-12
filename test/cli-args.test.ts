import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli-args.ts";

describe("parseArgs", () => {
  it("parses a per-turn harness and model", () => {
    expect(
      parseArgs(["ask", "--with", "opencode", "--model", "openai/gpt-5", "Review", "this"]),
    ).toEqual({
      name: "ask",
      harness: "opencode",
      model: "openai/gpt-5",
      prompt: "Review this",
    });
  });

  it("defaults new tasks to Codex", () => {
    expect(parseArgs(["new", "Fix", "checkout"])).toEqual({
      name: "new",
      title: "Fix checkout",
      harness: "codex",
    });
  });

  it("rejects unknown harnesses", () => {
    expect(() => parseArgs(["use", "claude"])).toThrow("Usage: relay use codex|opencode");
  });

  it("targets the active native session by default", () => {
    expect(parseArgs(["native"])).toEqual({ name: "native" });
    expect(parseArgs(["native", "opencode"])).toEqual({ name: "native", harness: "opencode" });
  });
});
