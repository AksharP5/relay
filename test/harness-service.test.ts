import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { HarnessService } from "../src/harnesses/harness-service.ts";
import { ProcessRunner, type ProcessInput } from "../src/services/process-runner.ts";

const runWithFake = async (harness: "codex" | "opencode", sessionId?: string, model?: string) => {
  let received: ProcessInput | undefined;
  const progress: Array<string> = [];
  const fakeRunner = Layer.succeed(ProcessRunner, {
    which: () => Effect.succeed(`/usr/local/bin/${harness}`),
    run: (input) =>
      Effect.sync(() => {
        received = input;
        if (harness === "codex") {
          input.onStdoutLine?.(
            JSON.stringify({ type: "thread.started", thread_id: sessionId ?? "codex-session" }),
          );
          input.onStdoutLine?.(
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "Codex response" },
            }),
          );
        } else {
          input.onStdoutLine?.(
            JSON.stringify({ type: "step_start", sessionID: sessionId ?? "opencode-session" }),
          );
          input.onStdoutLine?.(
            JSON.stringify({
              type: "text",
              sessionID: sessionId ?? "opencode-session",
              part: { text: "OpenCode response" },
            }),
          );
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* HarnessService;
      return yield* service.run(harness, {
        cwd: "/tmp/project",
        prompt: "Current request",
        handoff: [],
        ...(sessionId ? { sessionId } : {}),
        ...(model ? { model } : {}),
        onProgress: (event) => {
          if (event.type === "text") progress.push(event.text);
        },
      });
    }).pipe(Effect.provide(HarnessService.layer), Effect.provide(fakeRunner)),
  );
  return { result, received: received!, progress };
};

describe("HarnessService", () => {
  it("sends OpenCode prompts over stdin instead of argv", async () => {
    const { result, received, progress } = await runWithFake("opencode");
    expect(received.stdin).toBe("Current request");
    expect(received.args).not.toContain("Current request");
    expect(result).toEqual({ sessionId: "opencode-session", text: "OpenCode response" });
    expect(progress).toEqual(["OpenCode response"]);
  });

  it("resumes Codex with the native session id and streams the response", async () => {
    const { result, received, progress } = await runWithFake("codex", "codex-existing", "gpt-5.4");
    expect(received.args).toContain("codex-existing");
    expect(received.args).toContain("gpt-5.4");
    expect(received.stdin).toBe("Current request");
    expect(result.text).toBe("Codex response");
    expect(progress).toEqual(["Codex response"]);
  });
});
