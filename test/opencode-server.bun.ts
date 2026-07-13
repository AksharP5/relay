import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "bun:test";
import { discoverOpenCodeCommands, runOpenCodeControl } from "../src/harnesses/opencode-server.ts";

const executable = fileURLToPath(new URL("./fixtures/fake-opencode-server.ts", import.meta.url));

beforeAll(() => chmod(executable, 0o755));

describe("OpenCode command discovery", () => {
  it("loads and normalizes commands from the authenticated native server", async () => {
    const commands = await discoverOpenCodeCommands(executable, process.cwd());
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

  it("runs session controls without turning them into prompts", async () => {
    const compact = await runOpenCodeControl(executable, {
      cwd: process.cwd(),
      sessionId: "ses_test",
      action: "compact",
    });
    const share = await runOpenCodeControl(executable, {
      cwd: process.cwd(),
      sessionId: "ses_test",
      action: "share",
    });
    const unshare = await runOpenCodeControl(executable, {
      cwd: process.cwd(),
      sessionId: "ses_test",
      action: "unshare",
    });
    const undo = await runOpenCodeControl(executable, {
      cwd: process.cwd(),
      sessionId: "ses_test",
      action: "undo",
    });
    const redo = await runOpenCodeControl(executable, {
      cwd: process.cwd(),
      sessionId: "ses_test",
      action: "redo",
    });
    expect(compact).toBe("OpenCode compacted its native context.");
    expect(share).toBe("OpenCode shared this session: https://opncd.ai/s/test");
    expect(unshare).toBe("OpenCode stopped sharing this session.");
    expect(undo).toBe("OpenCode undid the previous turn and file changes.");
    expect(redo).toBe("OpenCode restored the previously undone turn.");
  });
});
