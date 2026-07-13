import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "bun:test";

import { OpenCodeNativeBackend, parseOpenCodeNativeTurns } from "../src/native/opencode-backend.ts";

const executable = fileURLToPath(new URL("./fixtures/fake-opencode-server.ts", import.meta.url));

beforeAll(() => chmod(executable, 0o755));

describe("OpenCode native backend", () => {
  it("imports only completed visible user/assistant turns", () => {
    expect(
      parseOpenCodeNativeTurns([
        {
          info: { id: "hidden", role: "user" },
          parts: [{ type: "text", text: "handoff", synthetic: true }],
        },
        {
          info: { id: "user-1", role: "user" },
          parts: [{ type: "text", text: "Fix checkout" }],
        },
        {
          info: { id: "assistant-1", role: "assistant", time: { completed: 2 } },
          parts: [
            { type: "reasoning", text: "hidden" },
            { type: "text", text: "Fixed checkout." },
          ],
        },
        {
          info: { id: "user-2", role: "user" },
          parts: [{ type: "text", text: "Incomplete" }],
        },
        {
          info: { id: "assistant-2", role: "assistant", time: { created: 3 } },
          parts: [{ type: "text", text: "still streaming" }],
        },
      ]),
    ).toEqual([{ id: "user-1", prompt: "Fix checkout", response: "Fixed checkout." }]);
  });

  it("does not import turns hidden by native OpenCode undo", () => {
    const messages = [
      { info: { id: "user-1", role: "user" }, parts: [{ type: "text", text: "Keep" }] },
      {
        info: { id: "assistant-1", role: "assistant", time: { completed: 2 } },
        parts: [{ type: "text", text: "Kept." }],
      },
      { info: { id: "user-2", role: "user" }, parts: [{ type: "text", text: "Undo" }] },
      {
        info: { id: "assistant-2", role: "assistant", time: { completed: 4 } },
        parts: [{ type: "text", text: "Undone." }],
      },
    ];
    expect(parseOpenCodeNativeTurns(messages, "user-2")).toEqual([
      { id: "user-1", prompt: "Keep", response: "Kept." },
    ]);
  });

  it("creates authenticated sessions and returns the native attach command", async () => {
    const backend = await OpenCodeNativeBackend.start(executable, process.cwd());
    try {
      const sessionId = await backend.ensureSession({ title: "Relay task" });
      expect(sessionId).toBe("ses_created");
      const command = backend.command(sessionId);
      expect(command.args).toContain("attach");
      expect(command.args).toContain("--session");
      expect(command.args).toContain(sessionId);
      expect(command.args).not.toContain(command.env?.OPENCODE_SERVER_PASSWORD);
      expect(command.env?.OPENCODE_SERVER_PASSWORD).toBeTruthy();
      expect(await backend.isIdle(sessionId)).toBe(true);
      expect(await backend.resolveSession(sessionId)).toBe(sessionId);
      await backend.inject(
        sessionId,
        [
          {
            id: "message-1",
            seq: 1,
            role: "user",
            content: "Inspect checkout",
            harness: "codex",
            createdAt: "2026-07-13T00:00:00.000Z",
          },
        ],
        7,
      );
    } finally {
      await backend.close();
    }
  });
});
