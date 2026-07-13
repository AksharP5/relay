import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "bun:test";
import { discoverOpenCodeCommands } from "../src/harnesses/opencode-server.ts";

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
});
