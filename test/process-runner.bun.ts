import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { ProcessRunner } from "../src/services/process-runner.ts";

describe("ProcessRunner on Bun", () => {
  it("writes stdin and closes the child pipe", async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run({
          command: process.execPath,
          args: ["-e", "process.stdin.pipe(process.stdout)"],
          stdin: "closed input",
          timeoutMs: 2_000,
        });
      }).pipe(Effect.provide(ProcessRunner.layer)),
    );

    expect(output.exitCode).toBe(0);
    expect(output.stdout).toBe("closed input");
  });
});
