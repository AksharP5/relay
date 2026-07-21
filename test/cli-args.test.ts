import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli-args.ts";

describe("parseArgs", () => {
  it("treats one positional argument as a native workspace directory", () => {
    expect(parseArgs(["."])).toEqual({ name: "open", directory: "." });
    expect(parseArgs(["../another-project"])).toEqual({
      name: "open",
      directory: "../another-project",
    });
    expect(parseArgs(["/tmp/relay-project"])).toEqual({
      name: "open",
      directory: "/tmp/relay-project",
    });
    expect(() => parseArgs(["--project"])).toThrow("Unknown option: --project");
    expect(() => parseArgs(["project", "extra"])).toThrow("invalid directory arguments");
  });

  it("uses -- to open exactly one command-like directory", () => {
    expect(parseArgs(["--", "native"])).toEqual({ name: "open", directory: "native" });
    expect(parseArgs(["./native"])).toEqual({ name: "open", directory: "./native" });
    expect(() => parseArgs(["--"])).toThrow("Usage: relay -- <directory>");
    expect(() => parseArgs(["--", "native", "extra"])).toThrow("Usage: relay -- <directory>");
  });

  it("rejects trailing operands for every fixed-arity command", () => {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [["help", "unexpected"], "Usage: relay help | --help | -h"],
      [["--help", "unexpected"], "Usage: relay help | --help | -h"],
      [["-h", "unexpected"], "Usage: relay help | --help | -h"],
      [["version", "unexpected"], "Usage: relay version | --version | -v"],
      [["--version", "unexpected"], "Usage: relay version | --version | -v"],
      [["-v", "unexpected"], "Usage: relay version | --version | -v"],
      [["doctor", "unexpected"], "Usage: relay doctor"],
      [["status", "unexpected"], "Usage: relay status"],
      [["list", "unexpected"], "Usage: relay list"],
      [["history", "unexpected"], "Usage: relay history"],
      [["native", "codex", "unexpected"], "Usage: relay native [codex|opencode]"],
      [["use", "codex", "unexpected"], "Usage: relay use codex|opencode"],
      [["thread", "abc123", "unexpected"], "Usage: relay thread <id>"],
    ];

    for (const [args, usage] of cases) {
      expect(() => parseArgs(args)).toThrow(usage);
    }
  });

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

  it("parses switch-key configuration commands without constraining the binding", () => {
    expect(parseArgs(["config"])).toEqual({ name: "config", action: "get" });
    expect(parseArgs(["config", "get", "switch-key"])).toEqual({
      name: "config",
      action: "get",
    });
    expect(parseArgs(["config", "set", "switch-key", "Super+Hyper+KeyCode:60000"])).toEqual({
      name: "config",
      action: "set",
      value: "Super+Hyper+KeyCode:60000",
    });
    expect(parseArgs(["config", "reset", "switch-key"])).toEqual({
      name: "config",
      action: "reset",
    });
    expect(() => parseArgs(["config", "set", "switch-key"])).toThrow("Usage: relay config");
  });

  it("parses task export and explicit deletion", () => {
    expect(parseArgs(["export", "abc123", "--out", "task.json"])).toEqual({
      name: "export",
      threadId: "abc123",
      output: "task.json",
    });
    expect(parseArgs(["delete", "abc123", "--force"])).toEqual({
      name: "delete",
      threadId: "abc123",
      force: true,
    });
    expect(() => parseArgs(["export", "abc123", "extra"])).toThrow("Usage: relay export [task-id]");
    expect(() => parseArgs(["delete", "abc123", "extra"])).toThrow("Usage: relay delete [task-id]");
  });
});
