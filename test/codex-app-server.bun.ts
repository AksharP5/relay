import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { AppServerProtocolError, runCodexCommand } from "../src/harnesses/codex-app-server.ts";

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

  it("times out and closes an unresponsive app-server request", async () => {
    await expect(
      runCodexCommand(executable, {
        command: "review",
        cwd: process.cwd(),
        arguments: "hang forever",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Timed out waiting for Codex review/start");
  });

  it("rejects valid JSON that is not a Codex RPC object", async () => {
    Bun.env.RELAY_TEST_CODEX_INVALID_JSON = "1";
    try {
      await expect(
        runCodexCommand(executable, {
          command: "compact",
          cwd: process.cwd(),
          arguments: "",
        }),
      ).rejects.toMatchObject({
        _tag: "AppServerProtocolError",
        source: "codex app-server",
      });
      expect(AppServerProtocolError).toBeDefined();
    } finally {
      delete Bun.env.RELAY_TEST_CODEX_INVALID_JSON;
    }
  });
});
