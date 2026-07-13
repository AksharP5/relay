import { describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("kills the complete child process group when interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-cancel-"));
    const marker = join(root, "orphan-finished");
    try {
      const program = Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run({
          command: "/bin/sh",
          args: ["-c", '(sleep 1; printf done > "$1") & wait', "relay-cancel-test", marker],
          timeoutMs: 5_000,
        });
      }).pipe(Effect.provide(ProcessRunner.layer));

      const fiber = Effect.runFork(program);
      await Bun.sleep(100);
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Bun.sleep(1_100);
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the timeout to descendant processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-timeout-"));
    const marker = join(root, "orphan-finished");
    try {
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const runner = yield* ProcessRunner;
          return yield* runner.run({
            command: "/bin/sh",
            args: ["-c", '(sleep 1; printf done > "$1") & wait', "relay-timeout-test", marker],
            timeoutMs: 100,
          });
        }).pipe(Effect.provide(ProcessRunner.layer)),
      );

      expect(output.exitCode).not.toBe(0);
      await Bun.sleep(1_100);
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
