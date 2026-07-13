import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runCodexCommand } from "../src/harnesses/codex-app-server.ts";

const executable = fileURLToPath(new URL("./fixtures/fake-codex-app-server.ts", import.meta.url));

beforeAll(() => chmod(executable, 0o755));

describe("Codex app-server commands", () => {
  it("waits for native compaction to complete", async () => {
    const result = await runCodexCommand(executable, {
      command: "compact",
      cwd: process.cwd(),
      arguments: "",
    });
    expect(result).toEqual({
      sessionId: "codex-thread",
      text: "Codex compacted its native context.",
    });
  });

  it("streams and returns an inline native review", async () => {
    const progress: Array<string> = [];
    const result = await runCodexCommand(executable, {
      command: "review",
      cwd: process.cwd(),
      sessionId: "codex-thread",
      arguments: "focus on correctness",
      handoffText: "prior Relay conversation",
      onProgress: (event) => {
        if (event.type === "text") progress.push(event.text);
      },
    });
    expect(result.text).toBe("Review complete");
    expect(progress).toEqual(["Review ", "Review complete"]);
  });
});
