import { describe, expect, it } from "bun:test";
import { Effect, Fiber, Layer } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessError } from "../src/errors.ts";
import { RelayPaths } from "../src/services/data-root.ts";
import { trackManagedProcess } from "../src/services/process-registry.ts";
import { ProcessRunner, stopProcessTree } from "../src/services/process-runner.ts";

describe("ProcessRunner on Bun", () => {
  it("reports spawn failures through the typed error channel", async () => {
    const command = "/relay-test/command-does-not-exist";
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run({ command }).pipe(Effect.flip);
      }).pipe(Effect.provide(ProcessRunner.layer)),
    );

    expect(failure).toBeInstanceOf(ProcessError);
    expect(failure).toMatchObject({ _tag: "ProcessError", operation: "run", command });
  });

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

  it("kills the complete child process group when interrupted during registration", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "relay-registration-cancel-"));
    const releaseChild = join(root, "release-child");
    const marker = join(root, "orphan-finished");
    const registrationStarted = Promise.withResolvers<ReturnType<typeof Bun.spawn>>();
    const releaseRegistration = Promise.withResolvers<void>();
    let interruption: Promise<unknown> | undefined;

    try {
      const layer = ProcessRunner.configuredLayerWith(async (dataRoot, child, kind) => {
        registrationStarted.resolve(child);
        await releaseRegistration.promise;
        await trackManagedProcess(dataRoot, child, kind);
      }).pipe(Layer.provide(RelayPaths.layerFromRoot(root)));
      const program = Effect.gen(function* () {
        const runner = yield* ProcessRunner;
        return yield* runner.run({
          command: "/bin/sh",
          args: [
            "-c",
            '(while [ ! -e "$1" ]; do sleep 0.01; done; printf done > "$2") & wait',
            "relay-registration-cancel-test",
            releaseChild,
            marker,
          ],
          timeoutMs: 2_000,
        });
      }).pipe(Effect.provide(layer));

      const fiber = Effect.runFork(program);
      const child = await registrationStarted.promise;
      interruption = Effect.runPromise(Fiber.interrupt(fiber));
      const leaderExited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(500).then(() => false),
      ]);

      expect(leaderExited).toBe(true);
      await writeFile(releaseChild, "");
      await Bun.sleep(100);
      await expect(readFile(marker, "utf8")).rejects.toThrow();

      releaseRegistration.resolve();
      await interruption;
    } finally {
      await writeFile(releaseChild, "").catch(() => undefined);
      releaseRegistration.resolve();
      await interruption?.catch(() => undefined);
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

  it("kills an ignoring descendant after the process-group leader exits", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "relay-descendant-"));
    const marker = join(root, "orphan-finished");
    try {
      const child = Bun.spawn(
        [
          "/bin/sh",
          "-c",
          `trap 'exit 0' TERM; (trap '' TERM; sleep 0.5; printf done > "$1") & wait`,
          "relay-descendant-test",
          marker,
        ],
        { stdout: "ignore", stderr: "ignore", detached: true },
      );
      await Bun.sleep(50);
      await stopProcessTree(child, 100);
      await Bun.sleep(550);
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
