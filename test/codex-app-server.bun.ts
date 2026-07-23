import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServerProtocolError, runCodexCommand } from "../src/harnesses/codex-app-server.ts";

const executable = fileURLToPath(new URL("./fixtures/fake-codex-app-server.ts", import.meta.url));
const dataRoot = await mkdtemp(join(tmpdir(), "relay-codex-server-root-"));

beforeAll(() => chmod(executable, 0o755));
afterAll(() => rm(dataRoot, { recursive: true, force: true }));

describe("Codex app-server commands", () => {
  it("waits for native compaction to complete", async () => {
    const result = await runCodexCommand(
      executable,
      {
        command: "compact",
        cwd: process.cwd(),
        arguments: "",
      },
      dataRoot,
    );
    expect(result).toEqual({
      sessionId: "codex-thread",
      text: "Codex compacted its native context.",
    });
  });

  it("streams and returns an inline native review", async () => {
    const progress: Array<string> = [];
    const result = await runCodexCommand(
      executable,
      {
        command: "review",
        cwd: process.cwd(),
        sessionId: "codex-thread",
        arguments: "focus on correctness",
        handoffText: "prior Relay conversation",
        onProgress: (event) => {
          if (event.type === "text") progress.push(event.text);
        },
      },
      dataRoot,
    );
    expect(result.text).toBe("Review complete");
    expect(progress).toEqual(["Review ", "Review complete"]);
  });

  it("times out and closes an unresponsive app-server request", async () => {
    const timeoutDataRoot = await mkdtemp(join(tmpdir(), "relay-codex-timeout-root-"));
    const reviewStarted = Promise.withResolvers<void>();
    // Freeze only the caller's timeout; the fixture must reach review/start on real process I/O.
    vi.useFakeTimers();
    try {
      const command = runCodexCommand(
        executable,
        {
          command: "review",
          cwd: process.cwd(),
          arguments: "hang forever",
          onProgress: () => reviewStarted.resolve(),
          timeoutMs: 50,
        },
        timeoutDataRoot,
      );
      await Promise.race([
        reviewStarted.promise,
        command.then(
          () => {
            throw new Error("Codex review unexpectedly completed");
          },
          (cause) => {
            throw cause;
          },
        ),
      ]);

      vi.advanceTimersByTime(50);

      await expect(command).rejects.toThrow("Timed out waiting for Codex review/start");
      expect(await readdir(join(timeoutDataRoot, "processes"))).toEqual([]);
    } finally {
      vi.useRealTimers();
      await rm(timeoutDataRoot, { recursive: true, force: true });
    }
  });

  it("rejects valid JSON that is not a Codex RPC object", async () => {
    Bun.env.RELAY_TEST_CODEX_INVALID_JSON = "1";
    try {
      await expect(
        runCodexCommand(
          executable,
          {
            command: "compact",
            cwd: process.cwd(),
            arguments: "",
          },
          dataRoot,
        ),
      ).rejects.toMatchObject({
        _tag: "AppServerProtocolError",
        source: "codex app-server",
      });
      expect(AppServerProtocolError).toBeDefined();
    } finally {
      delete Bun.env.RELAY_TEST_CODEX_INVALID_JSON;
    }
  });

  it("rejects a Codex RPC object with an invalid consumed field", async () => {
    Bun.env.RELAY_TEST_CODEX_INVALID_JSON = "field";
    try {
      await expect(
        runCodexCommand(
          executable,
          {
            command: "compact",
            cwd: process.cwd(),
            arguments: "",
          },
          dataRoot,
        ),
      ).rejects.toMatchObject({
        _tag: "AppServerProtocolError",
        source: "codex app-server",
      });
    } finally {
      delete Bun.env.RELAY_TEST_CODEX_INVALID_JSON;
    }
  });
});
