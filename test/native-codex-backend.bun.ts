import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexNativeBackend } from "../src/native/codex-backend.ts";
import { stopProcessTree } from "../src/services/process-runner.ts";

describe("Codex native startup", () => {
  it("removes its credential directory when spawn fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-codex-startup-test-"));
    const runtimeRoot = join(root, "tmp");
    const previousTmpdir = process.env.TMPDIR;
    await mkdir(runtimeRoot);
    process.env.TMPDIR = runtimeRoot;

    try {
      await expect(
        CodexNativeBackend.start("/relay-test/codex-does-not-exist", process.cwd(), root),
      ).rejects.toThrow();
      expect(await readdir(runtimeRoot)).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for interrupted registration before removing a late process claim", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "relay-codex-registration-test-"));
    const runtimeRoot = join(root, "tmp");
    const executable = join(root, "fake-codex");
    const previousTmpdir = process.env.TMPDIR;
    const registrationStarted = Promise.withResolvers<void>();
    const releaseRegistration = Promise.withResolvers<void>();
    const stopStarted = Promise.withResolvers<void>();
    const controller = new AbortController();
    let registered = false;
    let untrackedAfterRegistration = false;

    await mkdir(runtimeRoot);
    await writeFile(executable, "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    process.env.TMPDIR = runtimeRoot;

    try {
      const starting = CodexNativeBackend.start(
        executable,
        process.cwd(),
        join(root, "data"),
        controller.signal,
        {
          track: async () => {
            registrationStarted.resolve();
            await releaseRegistration.promise;
            registered = true;
          },
          stop: async (child) => {
            stopStarted.resolve();
            await stopProcessTree(child, 100);
          },
          untrack: async () => {
            untrackedAfterRegistration = registered;
            registered = false;
          },
        },
      );
      await registrationStarted.promise;
      controller.abort();
      await stopStarted.promise;
      releaseRegistration.resolve();

      await expect(starting).rejects.toThrow();
      expect(untrackedAfterRegistration).toBe(true);
      expect(registered).toBe(false);
      expect(await readdir(runtimeRoot)).toEqual([]);
    } finally {
      releaseRegistration.resolve();
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes credential files even when process cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-codex-cleanup-test-"));
    const runtimeRoot = join(root, "tmp");
    const previousTmpdir = process.env.TMPDIR;
    await mkdir(runtimeRoot);
    process.env.TMPDIR = runtimeRoot;

    try {
      await expect(
        CodexNativeBackend.start("/usr/bin/false", process.cwd(), root, undefined, {
          track: async () => undefined,
          stop: async (child) => {
            await stopProcessTree(child, 100);
            throw new Error("simulated process cleanup failure");
          },
          untrack: async () => undefined,
        }),
      ).rejects.toThrow("Codex app-server exited with code");
      expect(await readdir(runtimeRoot)).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await rm(root, { recursive: true, force: true });
    }
  });
});
