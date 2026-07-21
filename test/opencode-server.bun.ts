import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  discoverOpenCodeCommands,
  runOpenCodeCommand,
  runOpenCodeControl,
  startOpenCodeServer,
} from "../src/harnesses/opencode-server.ts";

const executable = fileURLToPath(new URL("./fixtures/fake-opencode-server.ts", import.meta.url));
const hangingExecutable = fileURLToPath(
  new URL("./fixtures/fake-hanging-opencode.sh", import.meta.url),
);
const dataRoot = await mkdtemp(join(tmpdir(), "relay-opencode-server-root-"));

beforeAll(() => Promise.all([chmod(executable, 0o755), chmod(hangingExecutable, 0o755)]));
afterAll(() => rm(dataRoot, { recursive: true, force: true }));

const processIdentity = async (pid: number) => {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
    const startTicks = stat
      ?.slice(stat.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/)[19];
    return startTicks ? `linux:${startTicks}` : undefined;
  }
  const child = Bun.spawn(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return exitCode === 0 && output.trim() ? output.trim() : undefined;
};

describe("OpenCode command discovery", () => {
  it("cancels and terminates a server interrupted during startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relay-opencode-abort-"));
    const pidPath = join(directory, "server.pid");
    const previousPidPath = Bun.env.RELAY_TEST_PID_FILE;
    Bun.env.RELAY_TEST_PID_FILE = pidPath;
    const controller = new AbortController();
    try {
      const starting = startOpenCodeServer(
        hangingExecutable,
        process.cwd(),
        dataRoot,
        controller.signal,
      );
      let pid: number | undefined;
      for (let attempt = 0; attempt < 100 && pid === undefined; attempt += 1) {
        pid = await readFile(pidPath, "utf8")
          .then((value) => Number(value.trim()))
          .catch(() => undefined);
        if (pid === undefined) await Bun.sleep(5);
      }
      expect(pid).toBeNumber();
      let identity: string | undefined;
      for (let attempt = 0; attempt < 100 && identity === undefined; attempt += 1) {
        identity = await processIdentity(pid!);
        if (identity === undefined) await Bun.sleep(5);
      }
      expect(identity).toBeString();
      const reason = new DOMException("test startup cancellation", "AbortError");
      controller.abort(reason);
      await expect(starting).rejects.toBe(reason);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await processIdentity(pid!)) !== identity) break;
        await Bun.sleep(5);
      }
      expect(await processIdentity(pid!)).not.toBe(identity);
    } finally {
      if (previousPidPath === undefined) delete Bun.env.RELAY_TEST_PID_FILE;
      else Bun.env.RELAY_TEST_PID_FILE = previousPidPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads and normalizes commands from the authenticated native server", async () => {
    const commands = await discoverOpenCodeCommands(executable, process.cwd(), dataRoot);
    expect(commands).toEqual([
      {
        name: "commit",
        description: "Create a conventional commit",
        source: "native",
        acceptsArguments: true,
      },
      {
        name: "skill-command",
        description: "Run OpenCode /skill-command",
        source: "native",
        acceptsArguments: true,
      },
    ]);
  });

  it("rejects valid JSON with the wrong OpenCode command shape", async () => {
    Bun.env.RELAY_TEST_OPENCODE_INVALID_COMMANDS = "1";
    try {
      await expect(
        discoverOpenCodeCommands(executable, process.cwd(), dataRoot),
      ).rejects.toMatchObject({
        _tag: "OpenCodeProtocolError",
        operation: "command catalog",
      });
    } finally {
      delete Bun.env.RELAY_TEST_OPENCODE_INVALID_COMMANDS;
    }
  });

  it("rejects an OpenCode command catalog with an invalid consumed field", async () => {
    Bun.env.RELAY_TEST_OPENCODE_INVALID_COMMANDS = "field";
    try {
      await expect(
        discoverOpenCodeCommands(executable, process.cwd(), dataRoot),
      ).rejects.toMatchObject({
        _tag: "OpenCodeProtocolError",
        operation: "command catalog",
      });
    } finally {
      delete Bun.env.RELAY_TEST_OPENCODE_INVALID_COMMANDS;
    }
  });

  it("runs session controls without turning them into prompts", async () => {
    const compact = await runOpenCodeControl(
      executable,
      {
        cwd: process.cwd(),
        sessionId: "ses_test",
        action: "compact",
      },
      dataRoot,
    );
    const share = await runOpenCodeControl(
      executable,
      {
        cwd: process.cwd(),
        sessionId: "ses_test",
        action: "share",
      },
      dataRoot,
    );
    const unshare = await runOpenCodeControl(
      executable,
      {
        cwd: process.cwd(),
        sessionId: "ses_test",
        action: "unshare",
      },
      dataRoot,
    );
    const undo = await runOpenCodeControl(
      executable,
      {
        cwd: process.cwd(),
        sessionId: "ses_test",
        action: "undo",
        expectedPrompt: "first",
      },
      dataRoot,
    );
    const redo = await runOpenCodeControl(
      executable,
      {
        cwd: process.cwd(),
        sessionId: "ses_test",
        action: "redo",
      },
      dataRoot,
    );
    expect(compact).toBe("OpenCode compacted its native context.");
    expect(share).toBe("OpenCode shared this session: https://opncd.ai/s/test");
    expect(unshare).toBe("OpenCode stopped sharing this session.");
    expect(undo).toBe("OpenCode undid the previous turn and file changes.");
    expect(redo).toBe("OpenCode restored the previously undone turn.");
  });

  it("refuses to undo an out-of-band native turn", async () => {
    await expect(
      runOpenCodeControl(
        executable,
        {
          cwd: process.cwd(),
          sessionId: "ses_test",
          action: "undo",
          expectedPrompt: "fir",
        },
        dataRoot,
      ),
    ).rejects.toThrow("does not match Relay history");
  });

  it("seeds missed context before a first native prompt command", async () => {
    const result = await runOpenCodeCommand(
      executable,
      {
        cwd: process.cwd(),
        command: "commit",
        arguments: "release-ready",
        handoffText: "prior Relay conversation",
      },
      dataRoot,
    );
    expect(result).toEqual({ sessionId: "ses_created", text: "Command response" });
  });

  it("rejects a valid but malformed OpenCode command response", async () => {
    Bun.env.RELAY_TEST_OPENCODE_INVALID_RESPONSE = "1";
    try {
      await expect(
        runOpenCodeCommand(
          executable,
          {
            cwd: process.cwd(),
            command: "commit",
            arguments: "release-ready",
            handoffText: "prior Relay conversation",
          },
          dataRoot,
        ),
      ).rejects.toMatchObject({
        _tag: "OpenCodeProtocolError",
        operation: "command response",
      });
    } finally {
      delete Bun.env.RELAY_TEST_OPENCODE_INVALID_RESPONSE;
    }
  });

  it("rejects an OpenCode command response with an invalid consumed field", async () => {
    Bun.env.RELAY_TEST_OPENCODE_INVALID_RESPONSE = "field";
    try {
      await expect(
        runOpenCodeCommand(
          executable,
          {
            cwd: process.cwd(),
            command: "commit",
            arguments: "release-ready",
            handoffText: "prior Relay conversation",
          },
          dataRoot,
        ),
      ).rejects.toMatchObject({
        _tag: "OpenCodeProtocolError",
        operation: "command response",
      });
    } finally {
      delete Bun.env.RELAY_TEST_OPENCODE_INVALID_RESPONSE;
    }
  });
});
